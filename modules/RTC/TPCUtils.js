
import { getLogger } from 'jitsi-meet-logger';

import * as JitsiTrackEvents from '../../JitsiTrackEvents';
import browser from '../browser';
import RTCEvents from '../../service/RTC/RTCEvents';
import {
    SIM_LAYER_1_RID,
    SIM_LAYER_2_RID,
    SIM_LAYER_3_RID
} from './TraceablePeerConnection';

const logger = getLogger(__filename);

/**
 *
 */
export default class TPCUtils {
    /**
     * @constructor
     */
    constructor(peerconnection) {
        this.pc = peerconnection;
        this.encodings = [
            {
                rid: SIM_LAYER_1_RID,
                active: true,
                scaleResolutionDownBy: 1.0
            },
            {
                rid: SIM_LAYER_2_RID,
                active: true,
                scaleResolutionDownBy: 2.0
            },
            {
                rid: SIM_LAYER_3_RID,
                active: true,
                scaleResolutionDownBy: 4.0
            }
        ];
    }

    /**
     * Obtains local tracks for given {@link MediaType}. If the <tt>mediaType</tt>
     * argument is omitted the list of all local tracks will be returned.
     * @param {MediaType} [mediaType]
     * @return {Array<JitsiLocalTrack>}
     */
    _getLocalTracks(mediaType) {
        if (!mediaType) {
            throw new Error('"mediaType" is required');
        }
        const tracks = Array.from(this.pc.localTracks.values());

        return tracks.filter(track => track.getType() === mediaType);
    }

    /**
     *
     * @param {*} localTrack
     */
    _getStreamEncodings(localTrack) {
        if (this.pc.isSimulcastOn() && localTrack.isVideoTrack()) {
            return this.encodings;
        }

        return [ { active: true } ];
    }

    /**
    * Add {@link JitsiLocalTrack} to this PC. This is called in the p2p case before a
    * session-initiate is sent to the remote peer.
    * @param {JitsiLocalTrack} track
    */
    async addTrack(localTrack, isInitiator = true) {
        const track = localTrack.getTrack();

        if (isInitiator) {
            // Use pc.addTransceiver() for the initiator case when local tracks are getting added
            // to the peerconnection before a session-initiate is sent over to the peer.
            const transceiverInit = {
                direction: 'sendrecv',
                streams: [ localTrack.getOriginalStream() ],
                sendEncodings: []
            };

            if (!browser.isFirefox()) {
                transceiverInit.sendEncodings = this._getStreamEncodings(localTrack);
            }

            try {
                await this.pc.peerconnection.addTransceiver(track, transceiverInit);
                this.pc.trace(`added transceiver for ${localTrack} to ${this.pc}`);
            } catch (err) {
                logger.error(`could not add transceiver for ${localTrack} to: ${this.pc}`, err);

                throw new Error('Could not add transceiver');
            }

        } else {
            // Use pc.addTrack() for responder case so that we can re-use the m-lines that were created
            // when setRemoteDescription was called. pc.addTrack() automatically  attaches to any existing
            // unused "recv-only" transceiver.
            await this.pc.peerconnection.addTrack(track);
        }

        return true;
    }

    /**
     *
     * @param {*} localTrack
     */
    async addTrackUnmute(localTrack) {
        const mediaType = localTrack.getType();
        const track = localTrack.getTrack();

        // The assumption here is that the first transceiver of the specified
        // media type is that of the local track.
        const transceiver = this.pc.peerconnection.getTransceivers()
            .find(t => t.receiver && t.receiver.track && t.receiver.track.kind === mediaType);

        if (!transceiver) {
            logger.error(`RTCRtpTransceiver for ${mediaType} on ${this.pc} not found`);

            return false;
        }

        logger.info(`Adding ${localTrack} on ${this.pc}`);

        // If the client starts with starts with audio/video muted setting,
        // the transceiver direction will be set to 'recvonly'. Use addStream
        // here so that a MSID is generated for the stream.
        if (transceiver.direction === 'recvonly') {
            this.pc.peerconnection.addStream(localTrack.getOriginalStream());
            this.setEncodings(localTrack);
        } else {
            await transceiver.sender.replaceTrack(track);
        }
        transceiver.direction = 'sendrecv';
        this.pc.localTracks.set(localTrack.rtcId, localTrack);

        return true;
    }

    /**
     *
     * @param {*} localTrack
     */
    async removeTrackMute(localTrack) {
        const mediaType = localTrack.getType();
        const transceiver = this.pc.peerconnection.getTransceivers()
            .find(t => t.sender && t.sender.track && t.sender.track.id === localTrack.getTrackId());

        if (!transceiver) {
            logger.error(`RTCRtpTransceiver for ${mediaType} on ${this.pc} not found`);

            return false;
        }

        logger.info(`Removing ${localTrack} on ${this.pc}`);
        await transceiver.sender.replaceTrack(null);
        if (browser.isSafariWithVP8()) {
            transceiver.direction = 'sendrecv';
        }
        this.pc.localTracks.delete(localTrack.rtcId);
        this.pc.localSSRCs.delete(localTrack.rtcId);

        return true;
    }

    /**
     *
     * @param {*} oldTrack
     * @param {*} newTrack
     */
    async replaceTrack(oldTrack, newTrack) {
        if (oldTrack && newTrack) {
            const mediaType = newTrack.getType();
            const stream = newTrack.getOriginalStream();
            const track = stream.getVideoTracks()[0];
            const transceiver = this.pc.peerconnection.getTransceivers()
                .find(t => t.receiver.track.kind === mediaType && !t.stopped);

            if (!transceiver) {
                logger.error(`RTCRtpTransceiver for ${mediaType} on ${this.pc} not found`);

                return false;
            }
            await transceiver.sender.replaceTrack(track);
            const ssrc = this.pc.localSSRCs.get(oldTrack.rtcId);

            this.pc.localTracks.delete(oldTrack.rtcId);
            this.pc.localSSRCs.delete(oldTrack.rtcId);
            this.pc._addedStreams = this.pc._addedStreams.filter(s => s !== stream);
            this.pc.localTracks.set(newTrack.rtcId, newTrack);

            // Override the msid of JitsiLocalTrack in order to be
            // consistent with the SDP values.
            // newTrack.storedMSID = oldTrack.storedMSID;
            this.pc._addedStreams.push(stream);

            this.pc.localSSRCs.set(newTrack.rtcId, ssrc);
            this.pc.eventEmitter.emit(
                RTCEvents.LOCAL_TRACK_SSRC_UPDATED,
                newTrack,
                this.pc._extractPrimarySSRC(ssrc));
        } else if (oldTrack && !newTrack) {
            await this.removeTrackMute(oldTrack);
            this.pc.localTracks.delete(oldTrack.rtcId);
            this.pc.localSSRCs.delete(oldTrack.rtcId);
        } else if (newTrack && !oldTrack) {
            const ssrc = this.pc.localSSRCs.get(newTrack.rtcId);

            await this.addTrackUnmute(newTrack);
            newTrack.emit(JitsiTrackEvents.TRACK_MUTE_CHANGED, newTrack);
            this.pc.localTracks.set(newTrack.rtcId, newTrack);
            this.pc.localSSRCs.set(newTrack.rtcId, ssrc);
        }

        // We return false here since we don't want renegotation to be triggered
        // after the tracks are replaced. The renegotiation will be triggered only
        // when the browser fires a negotiationneeded event.
        return false;
    }

    /**
     *
     * @param {*} active
     */
    setAudioTransferActive(active) {
        return this.setMediaTransferActive('audio', active);
    }

    /**
     * Set the simulcast stream encoding properties on the RTCRtpSender.
     * @param {*} track - the current track in use for which the encodings are to be set.
     */
    setEncodings(track) {
        const transceiver = this.pc.peerconnection.getTransceivers()
            .find(t => t.sender && t.sender.track && t.sender.track.kind === track.getType());
        const parameters = transceiver.sender.getParameters();

        parameters.encodings = this._getStreamEncodings(track);
        transceiver.sender.setParameters(parameters);
    }

    /**
     *
     * @param {*} mediaType
     * @param {*} active
     */
    setMediaTransferActive(mediaType, active) {
        const transceivers = this.pc.peerconnection.getTransceivers()
            .filter(t => t.receiver && t.receiver.track && t.receiver.track.kind === mediaType);

        if (active) {
            transceivers.forEach(transceiver => {
                if (this._getLocalTracks(mediaType).length > 0) {
                    transceiver.direction = 'sendrecv';
                    const parameters = transceiver.sender.getParameters();

                    if (parameters && parameters.encodings && parameters.encodings.length) {
                        parameters.encodings.forEach(encoding => {
                            encoding.active = true;
                        });
                        transceiver.sender.setParameters(parameters);
                    }
                } else {
                    transceiver.direction = 'recvonly';
                }
            });
        } else {
            transceivers.forEach(transceiver => {
                transceiver.direction = 'inactive';
            });
        }

        return true;
    }

    /**
     *
     * @param {*} active
     */
    setVideoTransferActive(active) {
        return this.setMediaTransferActive('video', active);
    }
}
