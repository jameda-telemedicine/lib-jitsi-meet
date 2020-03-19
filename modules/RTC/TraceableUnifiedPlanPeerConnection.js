/* global __filename, RTCSessionDescription */

import { getLogger } from 'jitsi-meet-logger';
import transform from 'sdp-transform';

import * as GlobalOnErrorHandler from '../util/GlobalOnErrorHandler';
import JitsiRemoteTrack from './JitsiRemoteTrack';
import * as JitsiTrackEvents from '../../JitsiTrackEvents';
import * as MediaType from '../../service/RTC/MediaType';
import LocalSdpMunger from './LocalSdpMunger';
import RTC from './RTC';
import RTCUtils from './RTCUtils';
import browser from '../browser';
import RTCEvents from '../../service/RTC/RTCEvents';
import RtxModifier from '../xmpp/RtxModifier';

// FIXME SDP tools should end up in some kind of util module
import SDP from '../xmpp/SDP';
import SdpConsistency from '../xmpp/SdpConsistency';
import { SdpTransformWrap } from '../xmpp/SdpTransformUtil';
import SDPUtil from '../xmpp/SDPUtil';
import * as SignalingEvents from '../../service/RTC/SignalingEvents';

const logger = getLogger(__filename);
const SIMULCAST_LAYERS = 3;
const SIM_LAYER_1_RID = '1';
const SIM_LAYER_2_RID = '2';
const SIM_LAYER_3_RID = '3';
const SIM_LAYER_RIDS = [ SIM_LAYER_1_RID, SIM_LAYER_2_RID, SIM_LAYER_3_RID ];
const SIM_LAYER_BITRATES_BPS = [ 200000, 700000, 2500000 ];
const DESKSTOP_SHARE_RATE = 500000;

/* eslint-disable max-params */

/**
 * Creates new instance of 'TraceableUnifiedPlanPeerConnection'.
 *
 * @param {RTC} rtc the instance of <tt>RTC</tt> service
 * @param {number} id the peer connection id assigned by the parent RTC module.
 * @param {SignalingLayer} signalingLayer the signaling layer instance
 * @param {object} iceConfig WebRTC 'PeerConnection' ICE config
 * @param {object} constraints WebRTC 'PeerConnection' constraints
 * @param {boolean} isP2P indicates whether or not the new instance will be used
 * in a peer to peer connection
 * @param {object} options <tt>TracablePeerConnection</tt> config options.
 * @param {boolean} options.disableSimulcast if set to 'true' will disable
 * the simulcast.
 * @param {boolean} options.disableRtx if set to 'true' will disable the RTX
 * @param {boolean} options.enableFirefoxSimulcast if set to 'true' will enable
 * experimental simulcast support on Firefox.
 * @param {boolean} options.capScreenshareBitrate if set to 'true' simulcast will
 * be disabled for screenshare and a max bitrate of 500Kbps will applied on the
 * stream.
 * @param {boolean} options.disableH264 If set to 'true' H264 will be
 *      disabled by removing it from the SDP.
 * @param {boolean} options.preferH264 if set to 'true' H264 will be preferred
 * over other video codecs.
 * @param {boolean} options.enableLayerSuspension if set to 'true', we will
 * cap the video send bitrate when we are told we have not been selected by
 * any endpoints (and therefore the non-thumbnail streams are not in use).
 * @param {boolean} options.startSilent If set to 'true' no audio will be sent or received.
 *
 * FIXME: initially the purpose of TraceableUnifiedPlanPeerConnection was to be able to
 * debug the peer connection. Since many other responsibilities have been added
 * it would make sense to extract a separate class from it and come up with
 * a more suitable name.
 *
 * @constructor
 */
export default function TraceableUnifiedPlanPeerConnection(
        rtc,
        id,
        signalingLayer,
        iceConfig,
        constraints,
        isP2P,
        options) {

    /**
     * Indicates whether or not this peer connection instance is actively
     * sending/receiving audio media. When set to <tt>false</tt> the SDP audio
     * media direction will be adjusted to 'inactive' in order to suspend
     * the transmission.
     * @type {boolean}
     * @private
     */
    this.audioTransferActive = !(options.startSilent === true);

    /**
     * The DTMF sender instance used to send DTMF tones.
     *
     * @type {RTCDTMFSender|undefined}
     * @private
     */
    this._dtmfSender = undefined;

    /**
     * @typedef {Object} TouchToneRequest
     * @property {string} tones - The DTMF tones string as defined by
     * {@code RTCDTMFSender.insertDTMF}, 'tones' argument.
     * @property {number} duration - The amount of time in milliseconds that
     * each DTMF should last.
     * @property {string} interToneGap - The length of time in miliseconds to
     * wait between tones.
     */
    /**
     * TouchToneRequests which are waiting to be played. This queue is filled
     * if there are touch tones currently being played.
     *
     * @type {Array<TouchToneRequest>}
     * @private
     */
    this._dtmfTonesQueue = [];

    /**
     * Indicates whether or not this peer connection instance is actively
     * sending/receiving video media. When set to <tt>false</tt> the SDP video
     * media direction will be adjusted to 'inactive' in order to suspend
     * the transmission.
     * @type {boolean}
     * @private
     */
    this.videoTransferActive = true;

    /**
     * The parent instance of RTC service which created this
     * <tt>TracablePeerConnection</tt>.
     * @type {RTC}
     */
    this.rtc = rtc;

    /**
     * The peer connection identifier assigned by the RTC module.
     * @type {number}
     */
    this.id = id;

    /**
     * Indicates whether or not this instance is used in a peer to peer
     * connection.
     * @type {boolean}
     */
    this.isP2P = isP2P;

    // FIXME: We should support multiple streams per jid.
    /**
     * The map holds remote tracks associated with this peer connection.
     * It maps user's JID to media type and remote track
     * (one track per media type per user's JID).
     * @type {Map<string, Map<MediaType, JitsiRemoteTrack>>}
     */
    this.remoteTracks = new Map();

    /**
     * A map which stores local tracks mapped by {@link JitsiLocalTrack.rtcId}
     * @type {Map<number, JitsiLocalTrack>}
     */
    this.localTracks = new Map();

    /**
     * Keeps tracks of the WebRTC <tt>MediaStream</tt>s that have been added to
     * the underlying WebRTC PeerConnection.
     * @type {Array}
     * @private
     */
    this._addedStreams = [];

    /**
     * @typedef {Object} TPCGroupInfo
     * @property {string} semantics the SSRC groups semantics
     * @property {Array<number>} ssrcs group's SSRCs in order where the first
     * one is group's primary SSRC, the second one is secondary (RTX) and so
     * on...
     */
    /**
     * @typedef {Object} TPCSSRCInfo
     * @property {Array<number>} ssrcs an array which holds all track's SSRCs
     * @property {Array<TPCGroupInfo>} groups an array stores all track's SSRC
     * groups
     */
    /**
     * Holds the info about local track's SSRCs mapped per their
     * {@link JitsiLocalTrack.rtcId}
     * @type {Map<number, TPCSSRCInfo>}
     */
    this.localSSRCs = new Map();

    /**
     * The local ICE username fragment for this session.
     */
    this.localUfrag = null;

    /**
     * The remote ICE username fragment for this session.
     */
    this.remoteUfrag = null;

    /**
     * The signaling layer which operates this peer connection.
     * @type {SignalingLayer}
     */
    this.signalingLayer = signalingLayer;

    // SignalingLayer listeners
    this._peerVideoTypeChanged = this._peerVideoTypeChanged.bind(this);
    this.signalingLayer.on(
        SignalingEvents.PEER_VIDEO_TYPE_CHANGED,
        this._peerVideoTypeChanged);

    this._peerMutedChanged = this._peerMutedChanged.bind(this);
    this.signalingLayer.on(
        SignalingEvents.PEER_MUTED_CHANGED,
        this._peerMutedChanged);
    this.options = options;

    this.peerconnection
        = new RTCUtils.RTCPeerConnectionType(iceConfig, constraints);
    this.updateLog = [];
    this.stats = {};
    this.statsinterval = null;

    /**
     * @type {number} The max number of stats to keep in this.stats. Limit to
     * 300 values, i.e. 5 minutes; set to 0 to disable
     */
    this.maxstats = options.maxstats;
    const Interop = require('@jitsi/sdp-interop').Interop;

    this.interop = new Interop();
    const Simulcast = require('@jitsi/sdp-simulcast');

    this.simulcast = new Simulcast({ numOfLayers: SIMULCAST_LAYERS,
        explodeRemoteSimulcast: false });
    this.sdpConsistency = new SdpConsistency(this.toString());

    /**
     * Munges local SDP provided to the Jingle Session in order to prevent from
     * sending SSRC updates on attach/detach and mute/unmute (for video).
     * @type {LocalSdpMunger}
     */
    this.localSdpMunger = new LocalSdpMunger(this);

    /**
     * TracablePeerConnection uses RTC's eventEmitter
     * @type {EventEmitter}
     */
    this.eventEmitter = rtc.eventEmitter;
    this.rtxModifier = new RtxModifier();

    // override as desired
    this.trace = (what, info) => {
        logger.debug(what, info);

        this.updateLog.push({
            time: new Date(),
            type: what,
            value: info || ''
        });
    };
    this.onicecandidate = null;
    this.peerconnection.onicecandidate = event => {
        this.trace(
            'onicecandidate',
            JSON.stringify(event.candidate, null, ' '));

        if (this.onicecandidate !== null) {
            this.onicecandidate(event);
        }
    };

    //  firefox change!!!
    // this.peerconnection.ontrack = event => {
    //     document.getElementById("received_video").srcObject = event.streams[0];
    //     document.getElementById("hangup-button").disabled = false;
    // };

    this.peerconnection.onaddstream
        = event => this._remoteStreamAdded(event.stream);
    this.peerconnection.onremovestream
        = event => this._remoteStreamRemoved(event.stream);
    this.onsignalingstatechange = null;
    this.peerconnection.onsignalingstatechange = event => {
        this.trace('onsignalingstatechange', this.signalingState);
        if (this.onsignalingstatechange !== null) {
            this.onsignalingstatechange(event);
        }
    };
    this.oniceconnectionstatechange = null;
    this.peerconnection.oniceconnectionstatechange = event => {
        this.trace('oniceconnectionstatechange', this.iceConnectionState);
        if (this.oniceconnectionstatechange !== null) {
            this.oniceconnectionstatechange(event);
        }
    };
    this.onnegotiationneeded = null;
    this.peerconnection.onnegotiationneeded = event => {
        this.trace('onnegotiationneeded');
        if (this.onnegotiationneeded !== null) {
            this.onnegotiationneeded(event);
        }
    };
    this.ondatachannel = null;
    this.peerconnection.ondatachannel = event => {
        this.trace('ondatachannel');
        if (this.ondatachannel !== null) {
            this.ondatachannel(event);
        }
    };

    if (this.maxstats) {
        this.statsinterval = window.setInterval(() => {
            this.getStats(stats => {
                if (stats.result
                    && typeof stats.result === 'function') {
                    const results = stats.result();

                    for (let i = 0; i < results.length; ++i) {
                        const res = results[i];

                        res.names().forEach(name => {
                            this._processStat(res, name, res.stat(name));
                        });
                    }
                } else {
                    stats.forEach(r => this._processStat(r, '', r));
                }
            }, () => {

                // empty error callback
            });
        }, 1000);
    }

    logger.info(`Create new ${this}`);
}

/* eslint-enable max-params */

/**
 * Process stat and adds it to the array of stats we store.
 * @param report the current stats report.
 * @param name the name of the report, if available
 * @param statValue the value to add.
 * @private
 */
TraceableUnifiedPlanPeerConnection.prototype._processStat
    = function(report, name, statValue) {
        const id = `${report.id}-${name}`;

        let s = this.stats[id];
        const now = new Date();

        if (!s) {
            this.stats[id] = s = {
                startTime: now,
                endTime: now,
                values: [],
                times: []
            };
        }
        s.values.push(statValue);
        s.times.push(now.getTime());
        if (s.values.length > this.maxstats) {
            s.values.shift();
            s.times.shift();
        }
        s.endTime = now;
    };

/**
 * Returns a string representation of a SessionDescription object.
 */
const dumpSDP = function(description) {
    if (typeof description === 'undefined' || description === null) {
        return '';
    }

    return `type: ${description.type}\r\n${description.sdp}`;
};


/**
 * Forwards the {@link peerconnection.iceConnectionState} state except that it
 * will convert "completed" into "connected" where both mean that the ICE has
 * succeeded and is up and running. We never see "completed" state for
 * the JVB connection, but it started appearing for the P2P one. This method
 * allows to adapt old logic to this new situation.
 * @return {string}
 */
TraceableUnifiedPlanPeerConnection.prototype.getConnectionState = function() {
    const state = this.peerconnection.iceConnectionState;

    if (state === 'completed') {
        return 'connected';
    }

    return state;
};

/**
 * Obtains the media direction for given {@link MediaType}. The method takes
 * into account whether or not there are any local tracks for media and
 * the {@link audioTransferActive} and {@link videoTransferActive} flags.
 * @param {MediaType} mediaType
 * @return {string} one of the SDP direction constants ('sendrecv, 'recvonly'
 * etc.) which should be used when setting local description on the peer
 * connection.
 * @private
 */
TraceableUnifiedPlanPeerConnection.prototype._getDesiredMediaDirection = function(
        mediaType) {
    let mediaTransferActive = true;

    if (mediaType === MediaType.AUDIO) {
        mediaTransferActive = this.audioTransferActive;
    } else if (mediaType === MediaType.VIDEO) {
        mediaTransferActive = this.videoTransferActive;
    }
    if (mediaTransferActive) {
        return this.hasAnyTracksOfType(mediaType) ? 'sendrecv' : 'recvonly';
    }

    return 'inactive';
};

/**
 * Tells whether or not this TPC instance is using Simulcast.
 * @return {boolean} <tt>true</tt> if simulcast is enabled and active or
 * <tt>false</tt> if it's turned off.
 */
TraceableUnifiedPlanPeerConnection.prototype.isSimulcastOn = function() {
    return !this.options.disableSimulcast
        && browser.supportsSimulcast()

        // Firefox has been added as supporting simulcast, but it is
        // experimental so we only want to do it for firefox if the config
        // option is set.  Unfortunately, browser::supportsSimulcast()
        // doesn't have a reference to the config options, so we have
        // to do it here
        && (!browser.isFirefox()
            || this.options.enableFirefoxSimulcast);
};

/**
 * Handles {@link SignalingEvents.PEER_VIDEO_TYPE_CHANGED}
 * @param {string} endpointId the video owner's ID (MUC nickname)
 * @param {VideoType} videoType the new value
 * @private
 */
TraceableUnifiedPlanPeerConnection.prototype._peerVideoTypeChanged = function(
        endpointId,
        videoType) {
    // Check if endpointId has a value to avoid action on random track
    if (!endpointId) {
        logger.error(`No endpointID on peerVideoTypeChanged ${this}`);

        return;
    }
    const videoTrack = this.getRemoteTracks(endpointId, MediaType.VIDEO);

    if (videoTrack.length) {
        // NOTE 1 track per media type is assumed
        videoTrack[0]._setVideoType(videoType);
    }
};

/**
 * Handles remote track mute / unmute events.
 * @param {string} endpointId the track owner's identifier (MUC nickname)
 * @param {MediaType} mediaType "audio" or "video"
 * @param {boolean} isMuted the new mute state
 * @private
 */
TraceableUnifiedPlanPeerConnection.prototype._peerMutedChanged = function(
        endpointId,
        mediaType,
        isMuted) {
    // Check if endpointId is a value to avoid doing action on all remote tracks
    if (!endpointId) {
        logger.error('On peerMuteChanged - no endpoint ID');

        return;
    }
    const track = this.getRemoteTracks(endpointId, mediaType);

    if (track.length) {
        // NOTE 1 track per media type is assumed
        track[0].setMute(isMuted);
    }
};

/**
 * Obtains local tracks for given {@link MediaType}. If the <tt>mediaType</tt>
 * argument is omitted the list of all local tracks will be returned.
 * @param {MediaType} [mediaType]
 * @return {Array<JitsiLocalTrack>}
 */
TraceableUnifiedPlanPeerConnection.prototype.getLocalTracks = function(mediaType) {
    let tracks = Array.from(this.localTracks.values());

    if (mediaType !== undefined) {
        tracks = tracks.filter(track => track.getType() === mediaType);
    }

    return tracks;
};

/**
 * Checks whether or not this {@link TraceableUnifiedPlanPeerConnection} instance contains
 * any local tracks for given <tt>mediaType</tt>.
 * @param {MediaType} mediaType
 * @return {boolean}
 */
TraceableUnifiedPlanPeerConnection.prototype.hasAnyTracksOfType = function(mediaType) {
    if (!mediaType) {
        throw new Error('"mediaType" is required');
    }

    return this.getLocalTracks(mediaType).length > 0;
};

/**
 * Obtains all remote tracks currently known to this PeerConnection instance.
 * @param {string} [endpointId] the track owner's identifier (MUC nickname)
 * @param {MediaType} [mediaType] the remote tracks will be filtered
 * by their media type if this argument is specified.
 * @return {Array<JitsiRemoteTrack>}
 */
TraceableUnifiedPlanPeerConnection.prototype.getRemoteTracks = function(
        endpointId,
        mediaType) {
    const remoteTracks = [];
    const endpoints
        = endpointId ? [ endpointId ] : this.remoteTracks.keys();

    for (const endpoint of endpoints) {
        const endpointTrackMap = this.remoteTracks.get(endpoint);

        if (!endpointTrackMap) {

            // Otherwise an empty Map() would have to be allocated above
            // eslint-disable-next-line no-continue
            continue;
        }

        for (const trackMediaType of endpointTrackMap.keys()) {
            // per media type filtering
            if (!mediaType || mediaType === trackMediaType) {
                const mediaTrack = endpointTrackMap.get(trackMediaType);

                if (mediaTrack) {
                    remoteTracks.push(mediaTrack);
                }
            }
        }
    }

    return remoteTracks;
};

/**
 * Tries to find {@link JitsiTrack} for given SSRC number. It will search both
 * local and remote tracks bound to this instance.
 * @param {number} ssrc
 * @return {JitsiTrack|null}
 */
TraceableUnifiedPlanPeerConnection.prototype.getTrackBySSRC = function(ssrc) {
    if (typeof ssrc !== 'number') {
        throw new Error(`SSRC ${ssrc} is not a number`);
    }
    for (const localTrack of this.localTracks.values()) {
        if (this.getLocalSSRC(localTrack) === ssrc) {
            return localTrack;
        }
    }
    for (const remoteTrack of this.getRemoteTracks()) {
        if (remoteTrack.getSSRC() === ssrc) {
            return remoteTrack;
        }
    }

    return null;
};

/**
 * Tries to find SSRC number for given {@link JitsiTrack} id. It will search
 * both local and remote tracks bound to this instance.
 * @param {string} id
 * @return {number|null}
 */
TraceableUnifiedPlanPeerConnection.prototype.getSsrcByTrackId = function(id) {

    const findTrackById = track => track.getTrack().id === id;
    const localTrack = this.getLocalTracks().find(findTrackById);

    if (localTrack) {
        return this.getLocalSSRC(localTrack);
    }

    const remoteTrack = this.getRemoteTracks().find(findTrackById);

    if (remoteTrack) {
        return remoteTrack.getSSRC();
    }

    return null;
};

/**
 * Called when new remote MediaStream is added to the PeerConnection.
 * @param {MediaStream} stream the WebRTC MediaStream for remote participant
 */
TraceableUnifiedPlanPeerConnection.prototype._remoteStreamAdded = function(stream) {
    const streamId = RTC.getStreamID(stream);

    if (!RTC.isUserStreamById(streamId)) {
        logger.info(
            `${this} ignored remote 'stream added' event for non-user stream`
             + `id: ${streamId}`);

        return;
    }

    // Bind 'addtrack'/'removetrack' event handlers
    if (browser.isChromiumBased()) {
        stream.onaddtrack = event => {
            this._remoteTrackAdded(stream, event.track);
        };
        stream.onremovetrack = event => {
            this._remoteTrackRemoved(stream, event.track);
        };
    }

    // Call remoteTrackAdded for each track in the stream
    const streamAudioTracks = stream.getAudioTracks();

    for (const audioTrack of streamAudioTracks) {
        this._remoteTrackAdded(stream, audioTrack);
    }
    const streamVideoTracks = stream.getVideoTracks();

    for (const videoTrack of streamVideoTracks) {
        this._remoteTrackAdded(stream, videoTrack);
    }
};


/**
 * Called on "track added" and "stream added" PeerConnection events (because we
 * handle streams on per track basis). Finds the owner and the SSRC for
 * the track and passes that to ChatRoom for further processing.
 * @param {MediaStream} stream the WebRTC MediaStream instance which is
 * the parent of the track
 * @param {MediaStreamTrack} track the WebRTC MediaStreamTrack added for remote
 * participant
 */
TraceableUnifiedPlanPeerConnection.prototype._remoteTrackAdded = function(stream, track) {
    const streamId = RTC.getStreamID(stream);
    const mediaType = track.kind;

    logger.info(`${this} remote track added:`, streamId, mediaType);

    // look up an associated JID for a stream id
    if (!mediaType) {
        GlobalOnErrorHandler.callErrorHandler(
            new Error(
                `MediaType undefined for remote track, stream id: ${streamId}`
            ));

        // Abort
        return;
    }

    const remoteSDP = new SDP(this.remoteDescription.sdp);
    const mediaLines
        = remoteSDP.media.filter(mls => mls.startsWith(`m=${mediaType}`));

    if (!mediaLines.length) {
        GlobalOnErrorHandler.callErrorHandler(
            new Error(
                `No media lines for type ${
                    mediaType} found in remote SDP for remote track: ${
                    streamId}`));

        // Abort
        return;
    }

    let ssrcLines = SDPUtil.findLines(mediaLines[0], 'a=ssrc:');

    // @PATCH-1 P2P Firefox <-> Firefox enrico.schwendig
    if (!browser.isFirefox()) {
        ssrcLines
            = ssrcLines.filter(line => line.indexOf(`msid:${streamId}`) !== -1);
    }

    if (!ssrcLines.length) {
        GlobalOnErrorHandler.callErrorHandler(
            new Error(
                `No SSRC lines for streamId ${
                    streamId} for remote track, media type: ${mediaType}`));

        // Abort
        return;
    }

    // FIXME the length of ssrcLines[0] not verified, but it will fail
    // with global error handler anyway
    const ssrcStr = ssrcLines[0].substring(7).split(' ')[0];
    const trackSsrc = Number(ssrcStr);
    const ownerEndpointId = this.signalingLayer.getSSRCOwner(trackSsrc);

    if (isNaN(trackSsrc) || trackSsrc < 0) {
        GlobalOnErrorHandler.callErrorHandler(
            new Error(
                `Invalid SSRC: ${ssrcStr} for remote track, msid: ${
                    streamId} media type: ${mediaType}`));

        // Abort
        return;
    } else if (!ownerEndpointId) {
        GlobalOnErrorHandler.callErrorHandler(
            new Error(
                `No SSRC owner known for: ${
                    trackSsrc} for remote track, msid: ${
                    streamId} media type: ${mediaType}`));

        // Abort
        return;
    }

    logger.log(`${this} associated ssrc`, ownerEndpointId, trackSsrc);

    const peerMediaInfo
        = this.signalingLayer.getPeerMediaInfo(ownerEndpointId, mediaType);

    if (!peerMediaInfo) {
        GlobalOnErrorHandler.callErrorHandler(
            new Error(
                `${this}: no peer media info available for ${
                    ownerEndpointId}`));

        return;
    }

    const muted = peerMediaInfo.muted;
    const videoType = peerMediaInfo.videoType; // can be undefined

    this._createRemoteTrack(
        ownerEndpointId, stream, track, mediaType, videoType, trackSsrc, muted);
};

// FIXME cleanup params
/* eslint-disable max-params */

/**
 * Initializes a new JitsiRemoteTrack instance with the data provided by
 * the signaling layer and SDP.
 *
 * @param {string} ownerEndpointId the owner's endpoint ID (MUC nickname)
 * @param {MediaStream} stream the WebRTC stream instance
 * @param {MediaStreamTrack} track the WebRTC track instance
 * @param {MediaType} mediaType the track's type of the media
 * @param {VideoType} [videoType] the track's type of the video (if applicable)
 * @param {number} ssrc the track's main SSRC number
 * @param {boolean} muted the initial muted status
 */
TraceableUnifiedPlanPeerConnection.prototype._createRemoteTrack = function(
        ownerEndpointId,
        stream,
        track,
        mediaType,
        videoType,
        ssrc,
        muted) {
    let remoteTracksMap = this.remoteTracks.get(ownerEndpointId);

    if (!remoteTracksMap) {
        remoteTracksMap = new Map();
        this.remoteTracks.set(ownerEndpointId, remoteTracksMap);
    }

    const existingTrack = remoteTracksMap.get(mediaType);

    if (existingTrack && existingTrack.getTrack() === track) {
        // Ignore duplicated event which can originate either from
        // 'onStreamAdded' or 'onTrackAdded'.
        logger.info(
            `${this} ignored duplicated remote track added event for: `
                + `${ownerEndpointId}, ${mediaType}`);

        return;
    } else if (existingTrack) {
        logger.error(
            `${this} overwriting remote track for`
                + `${ownerEndpointId} ${mediaType}`);
    }

    const remoteTrack
        = new JitsiRemoteTrack(
                this.rtc,
                this.rtc.conference,
                ownerEndpointId,
                stream,
                track,
                mediaType,
                videoType,
                ssrc,
                muted,
                this.isP2P);

    remoteTracksMap.set(mediaType, remoteTrack);

    this.eventEmitter.emit(RTCEvents.REMOTE_TRACK_ADDED, remoteTrack);
};

/* eslint-enable max-params */

/**
 * Handles remote stream removal.
 * @param stream the WebRTC MediaStream object which is being removed from the
 * PeerConnection
 */
TraceableUnifiedPlanPeerConnection.prototype._remoteStreamRemoved = function(stream) {
    if (!RTC.isUserStream(stream)) {
        const id = RTC.getStreamID(stream);

        logger.info(
            `Ignored remote 'stream removed' event for non-user stream ${id}`);

        return;
    }

    // Call remoteTrackRemoved for each track in the stream
    const streamVideoTracks = stream.getVideoTracks();

    for (const videoTrack of streamVideoTracks) {
        this._remoteTrackRemoved(stream, videoTrack);
    }
    const streamAudioTracks = stream.getAudioTracks();

    for (const audioTrack of streamAudioTracks) {
        this._remoteTrackRemoved(stream, audioTrack);
    }
};

/**
 * Handles remote media track removal.
 * @param {MediaStream} stream WebRTC MediaStream instance which is the parent
 * of the track.
 * @param {MediaStreamTrack} track the WebRTC MediaStreamTrack which has been
 * removed from the PeerConnection.
 */
TraceableUnifiedPlanPeerConnection.prototype._remoteTrackRemoved = function(
        stream,
        track) {
    const streamId = RTC.getStreamID(stream);
    const trackId = track && RTC.getTrackID(track);

    logger.info(`${this} - remote track removed: ${streamId}, ${trackId}`);

    if (!streamId) {
        GlobalOnErrorHandler.callErrorHandler(
            new Error(`${this} remote track removal failed - no stream ID`));

        return;
    }

    if (!trackId) {
        GlobalOnErrorHandler.callErrorHandler(
            new Error(`${this} remote track removal failed - no track ID`));

        return;
    }

    if (!this._removeRemoteTrackById(streamId, trackId)) {
        // NOTE this warning is always printed when user leaves the room,
        // because we remove remote tracks manually on MUC member left event,
        // before the SSRCs are removed by Jicofo. In most cases it is fine to
        // ignore this warning, but still it's better to keep it printed for
        // debugging purposes.
        //
        // We could change the behaviour to emit track removed only from here,
        // but the order of the events will change and consuming apps could
        // behave unexpectedly (the "user left" event would come before "track
        // removed" events).
        logger.warn(
            `${this} Removed track not found for msid: ${streamId},
             track id: ${trackId}`);
    }
};

/**
 * Finds remote track by it's stream and track ids.
 * @param {string} streamId the media stream id as defined by the WebRTC
 * @param {string} trackId the media track id as defined by the WebRTC
 * @return {JitsiRemoteTrack|undefined} the track's instance or
 * <tt>undefined</tt> if not found.
 * @private
 */
TraceableUnifiedPlanPeerConnection.prototype._getRemoteTrackById = function(
        streamId,
        trackId) {
    // .find will break the loop once the first match is found
    for (const endpointTrackMap of this.remoteTracks.values()) {
        for (const mediaTrack of endpointTrackMap.values()) {
            // FIXME verify and try to use ===
            /* eslint-disable eqeqeq */
            if (mediaTrack.getStreamId() == streamId
                && mediaTrack.getTrackId() == trackId) {
                return mediaTrack;
            }

            /* eslint-enable eqeqeq */
        }
    }

    return undefined;
};

/**
 * Removes all JitsiRemoteTracks associated with given MUC nickname
 * (resource part of the JID). Returns array of removed tracks.
 *
 * @param {string} owner - The resource part of the MUC JID.
 * @returns {JitsiRemoteTrack[]}
 */
TraceableUnifiedPlanPeerConnection.prototype.removeRemoteTracks = function(owner) {
    const removedTracks = [];
    const remoteTracksMap = this.remoteTracks.get(owner);

    if (remoteTracksMap) {
        const removedAudioTrack = remoteTracksMap.get(MediaType.AUDIO);
        const removedVideoTrack = remoteTracksMap.get(MediaType.VIDEO);

        removedAudioTrack && removedTracks.push(removedAudioTrack);
        removedVideoTrack && removedTracks.push(removedVideoTrack);

        this.remoteTracks.delete(owner);
    }

    logger.debug(
        `${this} removed remote tracks for ${owner} count: ${
            removedTracks.length}`);

    return removedTracks;
};

/**
 * Removes and disposes given <tt>JitsiRemoteTrack</tt> instance. Emits
 * {@link RTCEvents.REMOTE_TRACK_REMOVED}.
 * @param {JitsiRemoteTrack} toBeRemoved
 */
TraceableUnifiedPlanPeerConnection.prototype._removeRemoteTrack = function(toBeRemoved) {
    toBeRemoved.dispose();
    const participantId = toBeRemoved.getParticipantId();
    const remoteTracksMap = this.remoteTracks.get(participantId);

    if (!remoteTracksMap) {
        logger.error(
            `removeRemoteTrack: no remote tracks map for ${participantId}`);
    } else if (!remoteTracksMap.delete(toBeRemoved.getType())) {
        logger.error(
            `Failed to remove ${toBeRemoved} - type mapping messed up ?`);
    }
    this.eventEmitter.emit(RTCEvents.REMOTE_TRACK_REMOVED, toBeRemoved);
};

/**
 * Removes and disposes <tt>JitsiRemoteTrack</tt> identified by given stream and
 * track ids.
 *
 * @param {string} streamId the media stream id as defined by the WebRTC
 * @param {string} trackId the media track id as defined by the WebRTC
 * @returns {JitsiRemoteTrack|undefined} the track which has been removed or
 * <tt>undefined</tt> if no track matching given stream and track ids was
 * found.
 */
TraceableUnifiedPlanPeerConnection.prototype._removeRemoteTrackById = function(
        streamId,
        trackId) {
    const toBeRemoved = this._getRemoteTrackById(streamId, trackId);

    if (toBeRemoved) {
        this._removeRemoteTrack(toBeRemoved);
    }

    return toBeRemoved;
};

/**
 * @typedef {Object} SSRCGroupInfo
 * @property {Array<number>} ssrcs group's SSRCs
 * @property {string} semantics
 */
/**
 * @typedef {Object} TrackSSRCInfo
 * @property {Array<number>} ssrcs track's SSRCs
 * @property {Array<SSRCGroupInfo>} groups track's SSRC groups
 */
/**
 * Returns map with keys msid and <tt>TrackSSRCInfo</tt> values.
 * @param {Object} desc the WebRTC SDP instance.
 * @return {Map<string,TrackSSRCInfo>}
 */
function extractSSRCMap(desc) {
    /**
     * Track SSRC infos mapped by stream ID (msid)
     * @type {Map<string,TrackSSRCInfo>}
     */
    const ssrcMap = new Map();

    /**
     * Groups mapped by primary SSRC number
     * @type {Map<number,Array<SSRCGroupInfo>>}
     */
    const groupsMap = new Map();

    if (typeof desc !== 'object' || desc === null
        || typeof desc.sdp !== 'string') {
        logger.warn('An empty description was passed as an argument.');

        return ssrcMap;
    }

    const session = transform.parse(desc.sdp);

    if (!Array.isArray(session.media)) {
        return ssrcMap;
    }

    for (const mLine of session.media) {
        if (!Array.isArray(mLine.ssrcs)) {
            continue; // eslint-disable-line no-continue
        }

        if (Array.isArray(mLine.ssrcGroups)) {
            for (const group of mLine.ssrcGroups) {
                if (typeof group.semantics !== 'undefined'
                    && typeof group.ssrcs !== 'undefined') {
                    // Parse SSRCs and store as numbers
                    const groupSSRCs
                        = group.ssrcs.split(' ').map(
                            ssrcStr => parseInt(ssrcStr, 10));
                    const primarySSRC = groupSSRCs[0];

                    // Note that group.semantics is already present

                    group.ssrcs = groupSSRCs;

                    // eslint-disable-next-line max-depth
                    if (!groupsMap.has(primarySSRC)) {
                        groupsMap.set(primarySSRC, []);
                    }
                    groupsMap.get(primarySSRC).push(group);
                }
            }
        }
        for (const ssrc of mLine.ssrcs) {
            if (ssrc.attribute !== 'msid') {
                continue; // eslint-disable-line no-continue
            }

            const msid = ssrc.value;

            let ssrcInfo = ssrcMap.get(msid);

            if (!ssrcInfo) {
                ssrcInfo = {
                    ssrcs: [],
                    groups: [],
                    msid
                };
                ssrcMap.set(msid, ssrcInfo);
            }

            const ssrcNumber = ssrc.id;

            ssrcInfo.ssrcs.push(ssrcNumber);

            if (groupsMap.has(ssrcNumber)) {
                const ssrcGroups = groupsMap.get(ssrcNumber);

                for (const group of ssrcGroups) {
                    ssrcInfo.groups.push(group);
                }
            }
        }
    }

    return ssrcMap;
}

/**
 * Takes a SessionDescription object and returns a "normalized" version.
 * Currently it takes care of ordering the a=ssrc lines and denoting receive
 * only SSRCs.
 */
const normalizePlanB = function(desc) {
    if (typeof desc !== 'object' || desc === null
        || typeof desc.sdp !== 'string') {
        logger.warn('An empty description was passed as an argument.');

        return desc;
    }

    // eslint-disable-next-line no-shadow
    const transform = require('sdp-transform');
    const session = transform.parse(desc.sdp);

    if (typeof session !== 'undefined'
            && typeof session.media !== 'undefined'
            && Array.isArray(session.media)) {
        session.media.forEach(mLine => {

            // Chrome appears to be picky about the order in which a=ssrc lines
            // are listed in an m-line when rtx is enabled (and thus there are
            // a=ssrc-group lines with FID semantics). Specifically if we have
            // "a=ssrc-group:FID S1 S2" and the "a=ssrc:S2" lines appear before
            // the "a=ssrc:S1" lines, SRD fails.
            // So, put SSRC which appear as the first SSRC in an FID ssrc-group
            // first.
            const firstSsrcs = [];
            const newSsrcLines = [];

            if (typeof mLine.ssrcGroups !== 'undefined'
                && Array.isArray(mLine.ssrcGroups)) {
                mLine.ssrcGroups.forEach(group => {
                    if (typeof group.semantics !== 'undefined'
                        && group.semantics === 'FID') {
                        if (typeof group.ssrcs !== 'undefined') {
                            firstSsrcs.push(Number(group.ssrcs.split(' ')[0]));
                        }
                    }
                });
            }

            if (Array.isArray(mLine.ssrcs)) {
                let i;

                for (i = 0; i < mLine.ssrcs.length; i++) {
                    if (typeof mLine.ssrcs[i] === 'object'
                        && typeof mLine.ssrcs[i].id !== 'undefined'
                        && firstSsrcs.indexOf(mLine.ssrcs[i].id) >= 0) {
                        newSsrcLines.push(mLine.ssrcs[i]);
                        delete mLine.ssrcs[i];
                    }
                }

                for (i = 0; i < mLine.ssrcs.length; i++) {
                    if (typeof mLine.ssrcs[i] !== 'undefined') {
                        newSsrcLines.push(mLine.ssrcs[i]);
                    }
                }

                mLine.ssrcs = replaceDefaultUnifiedPlanMsid(newSsrcLines);
            }
        });
    }

    const resStr = transform.write(session);


    return new RTCSessionDescription({
        type: desc.type,
        sdp: resStr
    });
};

/**
 * Unified plan differentiates a remote track not associated with a stream using
 * the msid "-", which can incorrectly trigger an onaddstream event in plan-b.
 * For jitsi, these tracks are actually receive-only ssrcs. To prevent
 * onaddstream from firing, remove the ssrcs with msid "-" except the cname
 * line. Normally the ssrcs are not used by the client, as the bridge controls
 * media flow, but keep one reference to the ssrc for the p2p case.
 *
 * @param {Array<Object>} ssrcLines - The ssrc lines from a remote description.
 * @private
 * @returns {Array<Object>} ssrcLines with removed lines referencing msid "-".
 */
function replaceDefaultUnifiedPlanMsid(ssrcLines = []) {
    if (!browser.isChrome() || !browser.isVersionGreaterThan(70)) {
        return ssrcLines;
    }

    let filteredLines = [ ...ssrcLines ];

    const problematicSsrcIds = ssrcLines.filter(ssrcLine =>
        ssrcLine.attribute === 'mslabel' && ssrcLine.value === '-')
        .map(ssrcLine => ssrcLine.id);

    problematicSsrcIds.forEach(ssrcId => {
        // Find the cname which is to be modified and left in.
        const cnameLine = filteredLines.find(line =>
            line.id === ssrcId && line.attribute === 'cname');

        cnameLine.value = `recvonly-${ssrcId}`;

        // Remove all of lines for the ssrc.
        filteredLines
            = filteredLines.filter(line => line.id !== ssrcId);

        // But re-add the cname line so there is a reference kept to the ssrc
        // in the SDP.
        filteredLines.push(cnameLine);
    });

    return filteredLines;
}

/**
 * Makes sure that both audio and video directions are configured as 'sendrecv'.
 * @param {Object} localDescription the SDP object as defined by WebRTC.
 * @param {object} options <tt>TracablePeerConnection</tt> config options.
 */
const enforceSendRecv = function(localDescription, options) {
    if (!localDescription) {
        throw new Error('No local description passed in.');
    }

    const transformer = new SdpTransformWrap(localDescription.sdp);
    const audioMedia = transformer.selectMedia('audio');

    let changed = false;

    if (audioMedia && audioMedia.direction !== 'sendrecv') {
        if (options.startSilent) {
            audioMedia.direction = 'inactive';
        } else {
            audioMedia.direction = 'sendrecv';
        }

        changed = true;
    }

    const videoMedia = transformer.selectMedia('video');

    if (videoMedia && videoMedia.direction !== 'sendrecv') {
        videoMedia.direction = 'sendrecv';
        changed = true;
    }

    if (changed) {
        return new RTCSessionDescription({
            type: localDescription.type,
            sdp: transformer.toRawSDP()
        });
    }

    return localDescription;
};

/**
 *
 * @param {JitsiLocalTrack} localTrack
 */
TraceableUnifiedPlanPeerConnection.prototype.getLocalSSRC = function(localTrack) {
    const ssrcInfo = this._getSSRC(localTrack.rtcId);

    return ssrcInfo && ssrcInfo.ssrcs[0];
};

/**
 * When doing unified plan simulcast, we'll have a set of ssrcs with the
 * same msid but no ssrc-group, since unified plan signals the simulcast
 * group via the a=simulcast line.  Unfortunately, Jicofo will complain
 * if it sees ssrcs with matching msids but no ssrc-group, so we'll inject
 * an ssrc-group line to make Jicofo happy.
 * NOTE: unlike plan B simulcast, the ssrcs in this inject ssrc-group will
 * NOT necessarily be in order of quality (low to high) because:
 * a) when translating between unified plan and plan b the order of the ssrcs
 * is not preserved and
 * b) it isn't guaranteed that firefox will give them to us in order to begin
 * with
 * @param desc A session description object (with 'type' and 'sdp' fields)
 * @return A session description object with its sdp field modified to
 * contain an inject ssrc-group for simulcast
 */
TraceableUnifiedPlanPeerConnection.prototype._injectSsrcGroupForUnifiedSimulcast
    = function(desc) {
        const sdp = transform.parse(desc.sdp);
        const video = sdp.media.find(mline => mline.type === 'video');

        if (video.simulcast_03) {
            const ssrcs = [];

            video.ssrcs.forEach(ssrc => {
                if (ssrc.attribute === 'msid') {
                    ssrcs.push(ssrc.id);
                }
            });
            video.ssrcGroups = video.ssrcGroups || [];
            if (video.ssrcGroups.find(group => group.semantics === 'SIM')) {
                // Group already exists, no need to do anything
                return desc;
            }
            video.ssrcGroups.push({
                semantics: 'SIM',
                ssrcs: ssrcs.join(' ')
            });
        }

        return new RTCSessionDescription({
            type: desc.type,
            sdp: transform.write(sdp)
        });
    };

/* eslint-disable-next-line vars-on-top */
const getters = {
    signalingState() {
        return this.peerconnection.signalingState;
    },
    iceConnectionState() {
        return this.peerconnection.iceConnectionState;
    },
    localDescription() {
        let desc = this.peerconnection.localDescription;

        if (!desc) {
            logger.debug('getLocalDescription no localDescription found');

            return {};
        }

        this.trace('getLocalDescription::preTransform', dumpSDP(desc));

        // if we're running on FF, transform to Plan B first.
        // @PATCH-1 P2P Firefox <-> Firefox enrico.schwendig,
        // we deactivate this, because it is buggy in FF to FF communication
        if (browser.usesUnifiedPlan() && !browser.isFirefox()) {
            desc = this.interop.toPlanB(desc);
            this.trace('getLocalDescription::postTransform (Plan B)',
                dumpSDP(desc));

            desc = this._injectSsrcGroupForUnifiedSimulcast(desc);
            this.trace('getLocalDescription::postTransform (inject ssrc group)',
                dumpSDP(desc));
        }

        if (browser.doesVideoMuteByStreamRemove()) {
            desc = this.localSdpMunger.maybeAddMutedLocalVideoTracksToSDP(desc);
            logger.debug(
                'getLocalDescription::postTransform (munge local SDP)', desc);
        }

        // What comes out of this getter will be signalled over Jingle to
        // the other peer, so we need to make sure the media direction is
        // 'sendrecv' because we won't change the direction later and don't want
        // the other peer to think we can't send or receive.
        //
        // Note that the description we set in chrome does have the accurate
        // direction (e.g. 'recvonly'), since that is technically what is
        // happening (check setLocalDescription impl).
        desc = enforceSendRecv(desc, this.options);

        // See the method's doc for more info about this transformation.
        // @PATCH-1 P2P Firefox <-> Firefox enrico.schwendig,
        if (!browser.isFirefox()) {
            desc = this.localSdpMunger.transformStreamIdentifiers(desc);
        }

        return desc;
    },
    remoteDescription() {
        let desc = this.peerconnection.remoteDescription;

        this.trace('getRemoteDescription::preTransform', dumpSDP(desc));

        // if we're running on FF, transform to Plan B first.
        // @PATCH-1 P2P Firefox <-> Firefox enrico.schwendig,
        if (browser.usesUnifiedPlan() && !browser.isFirefox()) {
            desc = this.interop.toPlanB(desc);
            this.trace(
                'getRemoteDescription::postTransform (Plan B)', dumpSDP(desc));
        }

        return desc || {};
    }
};

Object.keys(getters).forEach(prop => {
    Object.defineProperty(
        TraceableUnifiedPlanPeerConnection.prototype,
        prop, {
            get: getters[prop]
        }
    );
});

TraceableUnifiedPlanPeerConnection.prototype._getSSRC = function(rtcId) {
    return this.localSSRCs.get(rtcId);
};

/**
 * Add {@link JitsiLocalTrack} to this TPC.
 * @param {JitsiLocalTrack} track
 */
TraceableUnifiedPlanPeerConnection.prototype.addTrack = function(track) {
    const rtcId = track.rtcId;

    logger.info(`add ${track} to: ${this}`);

    if (this.localTracks.has(rtcId)) {
        logger.error(`${track} is already in ${this}`);

        return;
    }

    this.localTracks.set(rtcId, track);

    const webrtcStream = track.getOriginalStream();

    if (webrtcStream) {
        this._addStream(webrtcStream);

    // It's not ok for a track to not have a WebRTC stream if:
    } else if (!browser.doesVideoMuteByStreamRemove()
                || track.isAudioTrack()
                || (track.isVideoTrack() && !track.isMuted())) {
        logger.error(`${this} no WebRTC stream for: ${track}`);
    }

    // Muted video tracks do not have WebRTC stream
    if (browser.doesVideoMuteByStreamRemove()
            && track.isVideoTrack() && track.isMuted()) {
        const ssrcInfo = this.generateNewStreamSSRCInfo(track);

        this.sdpConsistency.setPrimarySsrc(ssrcInfo.ssrcs[0]);
        const simGroup
            = ssrcInfo.groups.find(groupInfo => groupInfo.semantics === 'SIM');

        if (simGroup) {
            this.simulcast.setSsrcCache(simGroup.ssrcs);
        }
        const fidGroups
            = ssrcInfo.groups.filter(
                groupInfo => groupInfo.semantics === 'FID');

        if (fidGroups) {
            const rtxSsrcMapping = new Map();

            fidGroups.forEach(fidGroup => {
                const primarySsrc = fidGroup.ssrcs[0];
                const rtxSsrc = fidGroup.ssrcs[1];

                rtxSsrcMapping.set(primarySsrc, rtxSsrc);
            });
            this.rtxModifier.setSsrcCache(rtxSsrcMapping);
        }
    }
};

/**
 * Adds local track as part of the unmute operation.
 * @param {JitsiLocalTrack} track the track to be added as part of the unmute
 * operation
 * @return {boolean} <tt>true</tt> if the state of underlying PC has changed and
 * the renegotiation is required or <tt>false</tt> otherwise.
 */
TraceableUnifiedPlanPeerConnection.prototype.addTrackUnmute = function(track) {
    if (!this._assertTrackBelongs('addTrackUnmute', track)) {
        // Abort
        return false;
    }

    logger.info(`Adding ${track} as unmute to ${this}`);
    const webRtcStream = track.getOriginalStream();

    if (!webRtcStream) {
        logger.error(
            `Unable to add ${track} as unmute to ${this} - no WebRTC stream`);

        return false;
    }
    this._addStream(webRtcStream);

    return true;
};

/**
 * Adds WebRTC media stream to the underlying PeerConnection
 * @param {MediaStream} mediaStream
 * @private
 */
TraceableUnifiedPlanPeerConnection.prototype._addStream = function(mediaStream) {

    // @PATCH-1 P2P Firefox <-> Firefox enrico.schwendig,
    if (browser.isFirefox()) {
        const pc = this.peerconnection;

        mediaStream.getTracks().forEach(track => {
            pc.addTrack(track, mediaStream);
        });
    } else {
        this.peerconnection.addStream(mediaStream);
    }

    this._addedStreams.push(mediaStream);
};

/**
 * Removes WebRTC media stream from the underlying PeerConection
 * @param {MediaStream} mediaStream
 */
TraceableUnifiedPlanPeerConnection.prototype._removeStream = function(mediaStream) {
    if (browser.supportsRtpSender()) {
        this._handleSenderRemoveStream(mediaStream);
    } else {
        this.peerconnection.removeStream(mediaStream);
    }
    this._addedStreams
        = this._addedStreams.filter(stream => stream !== mediaStream);
};

/**
 * This method when called will check if given <tt>localTrack</tt> belongs to
 * this TPC (that it has been previously added using {@link addTrack}). If the
 * track does not belong an error message will be logged.
 * @param {string} methodName the method name that will be logged in an error
 * message
 * @param {JitsiLocalTrack} localTrack
 * @return {boolean} <tt>true</tt> if given local track belongs to this TPC or
 * <tt>false</tt> otherwise.
 * @private
 */
TraceableUnifiedPlanPeerConnection.prototype._assertTrackBelongs = function(
        methodName,
        localTrack) {
    const doesBelong = this.localTracks.has(localTrack.rtcId);

    if (!doesBelong) {
        logger.error(
            `${methodName}: ${localTrack} does not belong to ${this}`);
    }

    return doesBelong;
};

/**
 * Tells if the given WebRTC <tt>MediaStream</tt> has been added to
 * the underlying WebRTC PeerConnection.
 * @param {MediaStream} mediaStream
 * @returns {boolean}
 */
TraceableUnifiedPlanPeerConnection.prototype.isMediaStreamInPc = function(mediaStream) {
    return this._addedStreams.indexOf(mediaStream) > -1;
};

/**
 * Remove local track from this TPC.
 * @param {JitsiLocalTrack} localTrack the track to be removed from this TPC.
 *
 * FIXME It should probably remove a boolean just like {@link removeTrackMute}
 *       The same applies to addTrack.
 */
TraceableUnifiedPlanPeerConnection.prototype.removeTrack = function(localTrack) {
    const webRtcStream = localTrack.getOriginalStream();

    this.trace(
        'removeStream',
        localTrack.rtcId, webRtcStream ? webRtcStream.id : undefined);

    if (!this._assertTrackBelongs('removeStream', localTrack)) {
        // Abort - nothing to be done here
        return;
    }
    this.localTracks.delete(localTrack.rtcId);
    this.localSSRCs.delete(localTrack.rtcId);

    if (webRtcStream) {
        if (browser.supportsRtpSender()) {
            this._handleSenderRemoveStream(webRtcStream);
        } else {
            this.peerconnection.removeStream(webRtcStream);
        }
    }
};

/**
 * Returns the sender corresponding to the given media type.
 * @param {MEDIA_TYPE} mediaType - The media type 'audio' or 'video' to be used for the search.
 * @returns {RTPSender|undefined} - The found sender or undefined if no sender
 * was found.
 */
TraceableUnifiedPlanPeerConnection.prototype.findSenderByKind = function(mediaType) {
    return this.peerconnection.getSenders().find(s => s.track && s.track.kind === mediaType);
};

/**
 * Returns the sender corresponding to the given MediaStream.
 *
 * @param {MediaStream} stream - The media stream used for the search.
 * @returns {RTPSender|undefined} - The found sender or undefined if no sender
 * was found.
 */
TraceableUnifiedPlanPeerConnection.prototype.findSenderByStream = function(stream) {
    const track = stream.getTracks()[0];

    if (!track) {
        logger.error('Cannot find sender: no tracks.');

        return;
    }

    // Find the right sender (for audio or video)
    return this.peerconnection.getSenders().find(s => s.track === track);
};

/**
 * Replaces <tt>oldTrack</tt> with <tt>newTrack</tt> from the peer connection.
 * Either <tt>oldTrack</tt> or <tt>newTrack</tt> can be null; replacing a valid
 * <tt>oldTrack</tt> with a null <tt>newTrack</tt> effectively just removes
 * <tt>oldTrack</tt>
 *
 * @param {JitsiLocalTrack|null} oldTrack - The current track in use to be
 * replaced
 * @param {JitsiLocalTrack|null} newTrack - The new track to use
 * @returns {Promise<boolean>} - If the promise resolves with true,
 * renegotiation will be needed. Otherwise no renegotiation is needed.
 */
TraceableUnifiedPlanPeerConnection.prototype.replaceTrack = function(oldTrack, newTrack) {
    if (browser.supportsRtpSender() && oldTrack && newTrack) {
        // Add and than remove stream in FF leads to wrong local SDP. In order
        // to workaround the issue we need to use sender.replaceTrack().
        const sender = this.findSenderByStream(oldTrack.getOriginalStream());
        const stream = newTrack.getOriginalStream();

        if (sender && stream) {
            const track = stream.getTracks()[0];

            if (track) {
                return sender.replaceTrack(track, stream).then(() => {
                    // Since there is no need to do renegotiations we need to
                    // fix all ssrc-msid mappings here.
                    // NOTE: after sender.replaceTrack the sdp will remain the
                    // same but the stream attach to the new JitsiLocalTrack
                    // will have different msid. Luckily on FF we are not doing
                    // all the transformations related to video mute.

                    const ssrc = this.localSSRCs.get(oldTrack.rtcId);

                    this.localTracks.delete(oldTrack.rtcId);
                    this.localSSRCs.delete(oldTrack.rtcId);
                    this._addedStreams
                        = this._addedStreams.filter(s => s !== stream);

                    this.localTracks.set(newTrack.rtcId, newTrack);

                    // Override the msid of JitsiLocalTrack in order to be
                    // consistent with the SDP values.
                    newTrack.storedMSID = oldTrack.storedMSID;
                    this._addedStreams.push(stream);

                    this.localSSRCs.set(newTrack.rtcId, ssrc);
                    this.eventEmitter.emit(
                        RTCEvents.LOCAL_TRACK_SSRC_UPDATED,
                        newTrack,
                        extractPrimarySSRC(ssrc));

                    return false;
                });
            }
        }
    }

    if (oldTrack) {
        this.removeTrack(oldTrack);
    }
    if (newTrack) {
        this.addTrack(newTrack);
    }

    return Promise.resolve(true);
};

/**
 * Replaces the existing media stream from the underlying peerconnection with the new
 * mediastream that has been added to the JitsiLocalTrack. Renegotiation with the remote
 * peer is not needed in this case.
 * @param {JitsiLocalTrack} localTrack - the localtrack whose mediastream has been updated.
 * @return {Promise} - Promise resolved with undefined if the track is replaced,
 * or rejected with <tt>InvalidModificationError<tt> if the track cannot be replaced.
 */
TraceableUnifiedPlanPeerConnection.prototype.replaceTrackWithoutOfferAnswer = function(localTrack) {
    const newTrack = localTrack.stream.getTracks()[0];
    const sender = this.findSenderByKind(newTrack.kind);

    if (!sender) {
        return Promise.reject(new Error(`Could not find RTCRtpSender for ${newTrack.kind}`));
    }

    return sender.replaceTrack(newTrack)
        .then(() => {
            this._addedStreams = this._addedStreams.filter(s => s !== localTrack._originalStream);
            this._addedStreams.push(localTrack.stream);
            localTrack.emit(JitsiTrackEvents.TRACK_MUTE_CHANGED, localTrack);
        })
        .catch(err => {
            logger.error(`replaceTrackWithoutOfferAnswer - replaceTrack failed for ${newTrack.kind}`, err);
        });
};

/**
 * Removes local track as part of the mute operation.
 * @param {JitsiLocalTrack} localTrack the local track to be remove as part of
 * the mute operation.
 * @return {boolean} <tt>true</tt> if the underlying PeerConnection's state has
 * changed and the renegotiation is required or <tt>false</tt> otherwise.
 */
TraceableUnifiedPlanPeerConnection.prototype.removeTrackMute = function(localTrack) {
    const webRtcStream = localTrack.getOriginalStream();

    this.trace(
        'removeStreamMute',
        localTrack.rtcId, webRtcStream ? webRtcStream.id : null);

    if (!this._assertTrackBelongs('removeStreamMute', localTrack)) {
        // Abort - nothing to be done here
        return false;
    }

    if (webRtcStream) {
        logger.info(
            `Removing ${localTrack} as mute from ${this}`);
        this._removeStream(webRtcStream);

        return true;
    }

    logger.error(`removeStreamMute - no WebRTC stream for ${localTrack}`);

    return false;
};

/**
 * Remove stream handling for browsers supporting RTPSender
 * @param stream: webrtc media stream
 */
TraceableUnifiedPlanPeerConnection.prototype._handleSenderRemoveStream = function(
        stream) {
    if (!stream) {
        // There is nothing to be changed
        return;
    }

    const sender = this.findSenderByStream(stream);

    if (sender) {
        this.peerconnection.removeTrack(sender);
    } else {
        logger.log('Cannot remove tracks: no RTPSender.');
    }
};

TraceableUnifiedPlanPeerConnection.prototype.createDataChannel = function(label, opts) {
    this.trace('createDataChannel', label, opts);

    return this.peerconnection.createDataChannel(label, opts);
};

/**
 * Ensures that the simulcast ssrc-group appears after any other ssrc-groups
 * in the SDP so that simulcast is properly activated.
 *
 * @param {Object} localSdp the WebRTC session description instance for
 * the local description.
 * @private
 */
TraceableUnifiedPlanPeerConnection.prototype._ensureSimulcastGroupIsLast = function(
        localSdp) {
    let sdpStr = localSdp.sdp;

    const videoStartIndex = sdpStr.indexOf('m=video');
    const simStartIndex = sdpStr.indexOf('a=ssrc-group:SIM', videoStartIndex);

    let otherStartIndex = sdpStr.lastIndexOf('a=ssrc-group');

    if (simStartIndex === -1
        || otherStartIndex === -1
        || otherStartIndex === simStartIndex) {
        return localSdp;
    }

    const simEndIndex = sdpStr.indexOf('\r\n', simStartIndex);
    const simStr = sdpStr.substring(simStartIndex, simEndIndex + 2);

    sdpStr = sdpStr.replace(simStr, '');
    otherStartIndex = sdpStr.lastIndexOf('a=ssrc-group');
    const otherEndIndex = sdpStr.indexOf('\r\n', otherStartIndex);
    const sdpHead = sdpStr.slice(0, otherEndIndex);
    const simStrTrimmed = simStr.trim();
    const sdpTail = sdpStr.slice(otherEndIndex);

    sdpStr = `${sdpHead}\r\n${simStrTrimmed}${sdpTail}`;

    return new RTCSessionDescription({
        type: localSdp.type,
        sdp: sdpStr
    });
};

/**
 * Will adjust audio and video media direction in the given SDP object to
 * reflect the current status of the {@link audioTransferActive} and
 * {@link videoTransferActive} flags.
 * @param {Object} localDescription the WebRTC session description instance for
 * the local description.
 * @private
 */
TraceableUnifiedPlanPeerConnection.prototype._adjustLocalMediaDirection = function(
        localDescription) {
    const transformer = new SdpTransformWrap(localDescription.sdp);

    let modifiedDirection = false;

    const audioMedia = transformer.selectMedia('audio');

    if (audioMedia) {
        const desiredAudioDirection
            = this._getDesiredMediaDirection(MediaType.AUDIO);

        if (audioMedia.direction !== desiredAudioDirection) {
            audioMedia.direction = desiredAudioDirection;
            logger.info(
                `Adjusted local audio direction to ${desiredAudioDirection}`);
            modifiedDirection = true;
        }
    } else {
        logger.warn('No "audio" media found int the local description');
    }

    const videoMedia = transformer.selectMedia('video');

    if (videoMedia) {
        const desiredVideoDirection
            = this._getDesiredMediaDirection(MediaType.VIDEO);

        if (videoMedia.direction !== desiredVideoDirection) {
            videoMedia.direction = desiredVideoDirection;
            logger.info(
                `Adjusted local video direction to ${desiredVideoDirection}`);
            modifiedDirection = true;
        }
    } else {
        logger.warn('No "video" media found in the local description');
    }

    if (modifiedDirection) {
        return new RTCSessionDescription({
            type: localDescription.type,
            sdp: transformer.toRawSDP()
        });
    }

    return localDescription;
};

TraceableUnifiedPlanPeerConnection.prototype.setLocalDescription = function(description) {
    let localSdp = description;

    this.trace('setLocalDescription::preTransform', dumpSDP(localSdp));

    if (this.options.disableH264 || this.options.preferH264) {
        const parsedSdp = transform.parse(localSdp.sdp);
        const videoMLine = parsedSdp.media.find(m => m.type === 'video');

        if (this.options.disableH264) {
            SDPUtil.stripVideoCodec(videoMLine, 'h264');
        } else {
            SDPUtil.preferVideoCodec(videoMLine, 'h264');
        }

        localSdp = new RTCSessionDescription({
            type: localSdp.type,
            sdp: transform.write(parsedSdp)
        });

        this.trace('setLocalDescription::postTransform (H264)',
            dumpSDP(localSdp));
    }

    localSdp = this._adjustLocalMediaDirection(localSdp);

    localSdp = this._ensureSimulcastGroupIsLast(localSdp);

    // if we're using unified plan, transform to it first.
    // @PATCH-1 P2P Firefox <-> Firefox enrico.schwendig
    if (browser.usesUnifiedPlan() && !browser.isFirefox()) {
        localSdp = this.interop.toUnifiedPlan(localSdp);
        this.trace(
            'setLocalDescription::postTransform (Unified Plan)',
            dumpSDP(localSdp));
    }

    return new Promise((resolve, reject) => {
        this.peerconnection.setLocalDescription(localSdp)
            .then(() => {
                this.trace('setLocalDescriptionOnSuccess');
                const localUfrag = SDPUtil.getUfrag(localSdp.sdp);

                if (localUfrag !== this.localUfrag) {
                    this.localUfrag = localUfrag;
                    this.eventEmitter.emit(
                        RTCEvents.LOCAL_UFRAG_CHANGED, this, localUfrag);
                }
                resolve();
            }, err => {
                this.trace('setLocalDescriptionOnFailure', err);
                this.eventEmitter.emit(
                    RTCEvents.SET_LOCAL_DESCRIPTION_FAILED,
                    err, this);
                reject(err);
            });
    });
};

/**
 * Enables/disables audio media transmission on this peer connection. When
 * disabled the SDP audio media direction in the local SDP will be adjusted to
 * 'inactive' which means that no data will be sent nor accepted, but
 * the connection should be kept alive.
 * @param {boolean} active <tt>true</tt> to enable audio media transmission or
 * <tt>false</tt> to disable. If the value is not a boolean the call will have
 * no effect.
 * @return {boolean} <tt>true</tt> if the value has changed and sRD/sLD cycle
 * needs to be executed in order for the changes to take effect or
 * <tt>false</tt> if the given value was the same as the previous one.
 * @public
 */
TraceableUnifiedPlanPeerConnection.prototype.setAudioTransferActive = function(active) {
    logger.debug(`${this} audio transfer active: ${active}`);
    const changed = this.audioTransferActive !== active;

    this.audioTransferActive = active;

    return changed;
};

/**
 * Takes in a *unified plan* offer and inserts the appropriate
 * parameters for adding simulcast receive support.
 * @param {Object} desc - A session description object
 * @param {String} desc.type - the type (offer/answer)
 * @param {String} desc.sdp - the sdp content
 *
 * @return {Object} A session description (same format as above) object
 * with its sdp field modified to advertise simulcast receive support
 */
TraceableUnifiedPlanPeerConnection.prototype._insertUnifiedPlanSimulcastReceive
    = function(desc) {
        const sdp = transform.parse(desc.sdp);
        const video = sdp.media.find(mline => mline.type === 'video');

        // In order of lowest to highest spatial quality
        video.rids = [
            {
                id: SIM_LAYER_1_RID,
                direction: 'recv'
            },
            {
                id: SIM_LAYER_2_RID,
                direction: 'recv'
            },
            {
                id: SIM_LAYER_3_RID,
                direction: 'recv'
            }
        ];
        // eslint-disable-next-line camelcase
        video.simulcast_03 = {
            value: `recv rid=${SIM_LAYER_RIDS.join(';')}`
        };

        return new RTCSessionDescription({
            type: desc.type,
            sdp: transform.write(sdp)
        });
    };

/**
 * Sets the max bitrate on the RTCRtpSender so that the
 * bitrate of the enocder doesn't exceed the configured value.
 * This is needed for the desktop share until spec-complaint
 * simulcast is implemented.
 * @param {JitsiLocalTrack} localTrack - the local track whose
 * max bitrate is to be configured.
 */
TraceableUnifiedPlanPeerConnection.prototype.setMaxBitRate = function(localTrack) {
    const mediaType = localTrack.type;

    if (!this.options.capScreenshareBitrate
        || mediaType === MediaType.AUDIO) {

        return;
    }
    if (!this.peerconnection.getSenders) {
        logger.debug('Browser doesn\'t support RTCRtpSender');

        return;
    }
    const videoType = localTrack.videoType;
    const trackId = localTrack.track.id;

    this.peerconnection.getSenders()
        .filter(s => s.track && s.track.id === trackId)
        .forEach(sender => {
            try {
                const parameters = sender.getParameters();

                if (parameters.encodings && parameters.encodings.length) {
                    logger.info('Setting max bitrate on video stream');
                    for (const encoding in parameters.encodings) {
                        if (parameters.encodings.hasOwnProperty(encoding)) {
                            parameters.encodings[encoding].maxBitrate
                                = videoType === 'desktop'
                                    ? DESKSTOP_SHARE_RATE
                                    : SIM_LAYER_BITRATES_BPS[encoding];
                        }
                    }
                    sender.setParameters(parameters);
                }
            } catch (err) {
                logger.error('Browser does not support getParameters/setParamters '
                    + 'or setting max bitrate on the encodings: ', err);
            }
        });
};

TraceableUnifiedPlanPeerConnection.prototype.setRemoteDescription = function(description) {
    this.trace('setRemoteDescription::preTransform', dumpSDP(description));

    // TODO the focus should squeze or explode the remote simulcast
    // eslint-disable-next-line no-param-reassign
    description = this.simulcast.mungeRemoteDescription(description);
    this.trace(
        'setRemoteDescription::postTransform (simulcast)',
        dumpSDP(description));

    if (this.options.preferH264) {
        const parsedSdp = transform.parse(description.sdp);
        const videoMLine = parsedSdp.media.find(m => m.type === 'video');

        SDPUtil.preferVideoCodec(videoMLine, 'h264');

        // eslint-disable-next-line no-param-reassign
        description = new RTCSessionDescription({
            type: description.type,
            sdp: transform.write(parsedSdp)
        });
    }

    // If the browser uses unified plan, transform to it first
    // @PATCH-1 P2P Firefox <-> Firefox enrico.schwendig,
    if (browser.usesUnifiedPlan() && !browser.isFirefox()) {
        // eslint-disable-next-line no-param-reassign
        description = new RTCSessionDescription({
            type: description.type,
            sdp: this.rtxModifier.stripRtx(description.sdp)
        });

        this.trace(
            'setRemoteDescription::postTransform (stripRtx)',
            dumpSDP(description));

        // eslint-disable-next-line no-param-reassign
        description = this.interop.toUnifiedPlan(description);
        this.trace(
            'setRemoteDescription::postTransform (Plan A)',
            dumpSDP(description));

        if (this.isSimulcastOn()) {
            // eslint-disable-next-line no-param-reassign
            description = this._insertUnifiedPlanSimulcastReceive(description);
            this.trace(
                'setRemoteDescription::postTransform (sim receive)',
                dumpSDP(description));
        }
    } else {
        // Plan B
        // eslint-disable-next-line no-param-reassign
        description = normalizePlanB(description);
    }

    // Safari WebRTC errors when no supported video codec is found in the offer.
    // To prevent the error, inject H264 into the video mLine.
    if (browser.isSafariWithWebrtc() && !browser.isSafariWithVP8()) {
        logger.debug('Maybe injecting H264 into the remote description');

        // eslint-disable-next-line no-param-reassign
        description = this._injectH264IfNotPresent(description);
    }

    return new Promise((resolve, reject) => {
        this.peerconnection.setRemoteDescription(description)
            .then(() => {
                this.trace('setRemoteDescriptionOnSuccess');
                const remoteUfrag = SDPUtil.getUfrag(description.sdp);

                if (remoteUfrag !== this.remoteUfrag) {
                    this.remoteUfrag = remoteUfrag;
                    this.eventEmitter.emit(
                        RTCEvents.REMOTE_UFRAG_CHANGED, this, remoteUfrag);
                }
                resolve();
            }, err => {
                this.trace('setRemoteDescriptionOnFailure', err);
                this.eventEmitter.emit(
                    RTCEvents.SET_REMOTE_DESCRIPTION_FAILED,
                    err,
                    this);
                reject(err);
            });
    });
};

/**
 * Inserts an H264 payload into the description if not already present. This is
 * need for Safari WebRTC, which errors when no supported video codec is found
 * in the offer. Related bug reports:
 * https://bugs.webkit.org/show_bug.cgi?id=173141
 * https://bugs.chromium.org/p/webrtc/issues/detail?id=4957
 *
 * @param {RTCSessionDescription} description - An RTCSessionDescription
 * to inject with an H264 payload.
 * @private
 * @returns {RTCSessionDescription}
 */
TraceableUnifiedPlanPeerConnection.prototype._injectH264IfNotPresent = function(
        description) {
    const parsedSdp = transform.parse(description.sdp);
    const videoMLine = parsedSdp.media.find(m => m.type === 'video');

    if (!videoMLine) {
        logger.debug('No videoMLine found, no need to inject H264.');

        return description;
    }

    if (videoMLine.rtp.some(rtp => rtp.codec.toLowerCase() === 'h264')) {
        logger.debug('H264 codec found in video mLine, no need to inject.');

        return description;
    }

    const { fmtp, payloads, rtp } = videoMLine;
    const payloadsArray = payloads.toString().split(' ');

    let dummyPayloadType;

    for (let i = 127; i >= 96; i--) {
        if (!payloadsArray.includes(i)) {
            dummyPayloadType = i;
            payloadsArray.push(i);
            videoMLine.payloads = payloadsArray.join(' ');
            break;
        }
    }

    if (typeof dummyPayloadType === 'undefined') {
        logger.error('Could not find valid payload type to inject.');

        return description;
    }

    rtp.push({
        codec: 'H264',
        payload: dummyPayloadType,
        rate: 90000
    });

    fmtp.push({
        config: 'level-asymmetry-allowed=1;'
            + 'packetization-mode=1;'
            + 'profile-level-id=42e01f',
        payload: dummyPayloadType
    });

    logger.debug(
        `Injecting H264 payload type ${dummyPayloadType} into video mLine.`);

    return new RTCSessionDescription({
        type: description.type,
        sdp: transform.write(parsedSdp)
    });
};

/**
 * Enables/disables video media transmission on this peer connection. When
 * disabled the SDP video media direction in the local SDP will be adjusted to
 * 'inactive' which means that no data will be sent nor accepted, but
 * the connection should be kept alive.
 * @param {boolean} active <tt>true</tt> to enable video media transmission or
 * <tt>false</tt> to disable. If the value is not a boolean the call will have
 * no effect.
 * @return {boolean} <tt>true</tt> if the value has changed and sRD/sLD cycle
 * needs to be executed in order for the changes to take effect or
 * <tt>false</tt> if the given value was the same as the previous one.
 * @public
 */
TraceableUnifiedPlanPeerConnection.prototype.setVideoTransferActive = function(active) {
    logger.debug(`${this} video transfer active: ${active}`);
    const changed = this.videoTransferActive !== active;

    this.videoTransferActive = active;

    return changed;
};

/**
 * Sends DTMF tones if possible.
 *
 * @param {string} tones - The DTMF tones string as defined by {@code RTCDTMFSender.insertDTMF}, 'tones' argument.
 * @param {number} duration - The amount of time in milliseconds that each DTMF should last. It's 200ms by default.
 * @param {number} interToneGap - The length of time in miliseconds to wait between tones. It's 200ms by default.
 *
 * @returns {void}
 */
TraceableUnifiedPlanPeerConnection.prototype.sendTones = function(tones, duration = 200, interToneGap = 200) {
    if (!this._dtmfSender) {
        if (this.peerconnection.getSenders) {
            const rtpSender = this.peerconnection.getSenders().find(s => s.dtmf);

            this._dtmfSender = rtpSender && rtpSender.dtmf;
            this._dtmfSender && logger.info(`${this} initialized DTMFSender using getSenders`);
        }

        if (!this._dtmfSender) {
            const localAudioTrack = Array.from(this.localTracks.values()).find(t => t.isAudioTrack());

            if (this.peerconnection.createDTMFSender && localAudioTrack) {
                this._dtmfSender = this.peerconnection.createDTMFSender(localAudioTrack.getTrack());
            }
            this._dtmfSender && logger.info(`${this} initialized DTMFSender using deprecated createDTMFSender`);
        }

        if (this._dtmfSender) {
            this._dtmfSender.ontonechange = this._onToneChange.bind(this);
        }
    }

    if (this._dtmfSender) {
        if (this._dtmfSender.toneBuffer) {
            this._dtmfTonesQueue.push({
                tones,
                duration,
                interToneGap
            });

            return;
        }

        this._dtmfSender.insertDTMF(tones, duration, interToneGap);
    } else {
        logger.warn(`${this} sendTones - failed to select DTMFSender`);
    }
};

/**
 * Callback ivoked by {@code this._dtmfSender} when it has finished playing
 * a single tone.
 *
 * @param {Object} event - The tonechange event which indicates what characters
 * are left to be played for the current tone.
 * @private
 * @returns {void}
 */
TraceableUnifiedPlanPeerConnection.prototype._onToneChange = function(event) {
    // An empty event.tone indicates the current tones have finished playing.
    // Automatically start playing any queued tones on finish.
    if (this._dtmfSender && event.tone === '' && this._dtmfTonesQueue.length) {
        const { tones, duration, interToneGap } = this._dtmfTonesQueue.shift();

        this._dtmfSender.insertDTMF(tones, duration, interToneGap);
    }
};

/**
 * Makes the underlying TraceableUnifiedPlanPeerConnection generate new SSRC for
 * the recvonly video stream.
 */
TraceableUnifiedPlanPeerConnection.prototype.generateRecvonlySsrc = function() {
    const newSSRC = SDPUtil.generateSsrc();

    logger.info(`${this} generated new recvonly SSRC: ${newSSRC}`);
    this.sdpConsistency.setPrimarySsrc(newSSRC);
};

/**
 * Makes the underlying TraceableUnifiedPlanPeerConnection forget the current primary video
 * SSRC.
 */
TraceableUnifiedPlanPeerConnection.prototype.clearRecvonlySsrc = function() {
    logger.info('Clearing primary video SSRC!');
    this.sdpConsistency.clearVideoSsrcCache();
};

/**
 * Closes underlying WebRTC PeerConnection instance and removes all remote
 * tracks by emitting {@link RTCEvents.REMOTE_TRACK_REMOVED} for each one of
 * them.
 */
TraceableUnifiedPlanPeerConnection.prototype.close = function() {
    this.trace('stop');

    // Off SignalingEvents
    this.signalingLayer.off(
        SignalingEvents.PEER_MUTED_CHANGED, this._peerMutedChanged);
    this.signalingLayer.off(
        SignalingEvents.PEER_VIDEO_TYPE_CHANGED, this._peerVideoTypeChanged);

    for (const peerTracks of this.remoteTracks.values()) {
        for (const remoteTrack of peerTracks.values()) {
            this._removeRemoteTrack(remoteTrack);
        }
    }
    this.remoteTracks.clear();

    this._addedStreams = [];

    this._dtmfSender = null;
    this._dtmfTonesQueue = [];

    if (!this.rtc._removePeerConnection(this)) {
        logger.error('RTC._removePeerConnection returned false');
    }
    if (this.statsinterval !== null) {
        window.clearInterval(this.statsinterval);
        this.statsinterval = null;
    }
    logger.info(`Closing ${this}...`);
    this.peerconnection.close();
};

/**
 * Modifies the values of the setup attributes (defined by
 * {@link http://tools.ietf.org/html/rfc4145#section-4}) of a specific SDP
 * answer in order to overcome a delay of 1 second in the connection
 * establishment between some devices and Videobridge.
 *
 * @param {SDP} offer - the SDP offer to which the specified SDP answer is
 * being prepared to respond
 * @param {SDP} answer - the SDP to modify
 * @private
 */
const _fixAnswerRFC4145Setup = function(offer, answer) {
    if (!(browser.isChromiumBased() || browser.isReactNative())) {
        // It looks like Firefox doesn't agree with the fix (at least in its
        // current implementation) because it effectively remains active even
        // after we tell it to become passive. Apart from Firefox which I tested
        // after the fix was deployed, I tested Chrome only. In order to prevent
        // issues with other browsers, limit the fix to known devices for the
        // time being.
        return;
    }

    // XXX Videobridge is the (SDP) offerer and WebRTC (e.g. Chrome) is the
    // answerer (as orchestrated by Jicofo). In accord with
    // http://tools.ietf.org/html/rfc5245#section-5.2 and because both peers
    // are ICE FULL agents, Videobridge will take on the controlling role and
    // WebRTC will take on the controlled role. In accord with
    // https://tools.ietf.org/html/rfc5763#section-5, Videobridge will use the
    // setup attribute value of setup:actpass and WebRTC will be allowed to
    // choose either the setup attribute value of setup:active or
    // setup:passive. Chrome will by default choose setup:active because it is
    // RECOMMENDED by the respective RFC since setup:passive adds additional
    // latency. The case of setup:active allows WebRTC to send a DTLS
    // ClientHello as soon as an ICE connectivity check of its succeeds.
    // Unfortunately, Videobridge will be unable to respond immediately because
    // may not have WebRTC's answer or may have not completed the ICE
    // connectivity establishment. Even more unfortunate is that in the
    // described scenario Chrome's DTLS implementation will insist on
    // retransmitting its ClientHello after a second (the time is in accord
    // with the respective RFC) and will thus cause the whole connection
    // establishment to exceed at least 1 second. To work around Chrome's
    // idiosyncracy, don't allow it to send a ClientHello i.e. change its
    // default choice of setup:active to setup:passive.
    if (offer && answer
            && offer.media && answer.media
            && offer.media.length === answer.media.length) {
        answer.media.forEach((a, i) => {
            if (SDPUtil.findLine(
                    offer.media[i],
                    'a=setup:actpass',
                    offer.session)) {
                answer.media[i]
                    = a.replace(/a=setup:active/g, 'a=setup:passive');
            }
        });
        answer.raw = answer.session + answer.media.join('');
    }
};

TraceableUnifiedPlanPeerConnection.prototype.createAnswer = function(constraints) {
    if (browser.isFirefox() && this.isSimulcastOn()) {
        const videoSender
            = this.peerconnection.getSenders().find(sender =>
                sender.track !== null && sender.track.kind === 'video');
        const simParams = {
            encodings: [
                {
                    rid: SIM_LAYER_1_RID,
                    scaleResolutionDownBy: 4
                },
                {
                    rid: SIM_LAYER_2_RID,
                    scaleResolutionDownBy: 2
                },
                {
                    rid: SIM_LAYER_3_RID
                }
            ]
        };

        videoSender.setParameters(simParams);
    }

    return this._createOfferOrAnswer(false /* answer */, constraints);
};

TraceableUnifiedPlanPeerConnection.prototype.createOffer = function(constraints) {
    return this._createOfferOrAnswer(true /* offer */, constraints);
};

/**
 * Checks if a camera track has been added to the peerconnection
 * @param {TraceableUnifiedPlanPeerConnection} peerConnection
 * @return {boolean} <tt>true</tt> if the peerconnection has
 * a camera track for its video source <tt>false</tt> otherwise.
 */
function hasCameraTrack(peerConnection) {
    return peerConnection.getLocalTracks()
        .some(t => t.videoType === 'camera');
}

TraceableUnifiedPlanPeerConnection.prototype._createOfferOrAnswer = function(
        isOffer,
        constraints) {
    const logName = isOffer ? 'Offer' : 'Answer';

    this.trace(`create${logName}`, JSON.stringify(constraints, null, ' '));

    const handleSuccess = (resultSdp, resolveFn, rejectFn) => {
        try {
            this.trace(
                `create${logName}OnSuccess::preTransform`, dumpSDP(resultSdp));

            // if we're using unified plan, transform to Plan B.
            // @PATCH-1 P2P Firefox <-> Firefox enrico.schwendig
            if (!browser.isFirefox()) {
                if (browser.usesUnifiedPlan()) {
                    // eslint-disable-next-line no-param-reassign
                    resultSdp = this.interop.toPlanB(resultSdp);
                    this.trace(
                        `create${logName}OnSuccess::postTransform (Plan B)`,
                        dumpSDP(resultSdp));
                    if (this.isSimulcastOn()) {
                        // eslint-disable-next-line no-param-reassign
                        resultSdp
                            = this._injectSsrcGroupForUnifiedSimulcast(resultSdp);
                        this.trace(
                            `create${logName}OnSuccess::postTransform`
                            + '(inject ssrc group)', dumpSDP(resultSdp));
                    }
                }

                /**
                 * We don't keep ssrcs consitent for Firefox because rewriting
                 *  the ssrcs between createAnswer and setLocalDescription breaks
                 *  the caching in sdp-interop (sdp-interop must know about all
                 *  ssrcs, and it updates its cache in toPlanB so if we rewrite them
                 *  after that, when we try and go back to unified plan it will
                 *  complain about unmapped ssrcs)
                 */
                if (!browser.usesUnifiedPlan()) {
                    // If there are no local video tracks, then a "recvonly"
                    // SSRC needs to be generated
                    if (!this.hasAnyTracksOfType(MediaType.VIDEO)
                        && !this.sdpConsistency.hasPrimarySsrcCached()) {
                        this.generateRecvonlySsrc();
                    }

                    // eslint-disable-next-line no-param-reassign
                    resultSdp = new RTCSessionDescription({
                        type: resultSdp.type,
                        sdp: this.sdpConsistency.makeVideoPrimarySsrcsConsistent(
                            resultSdp.sdp)
                    });

                    this.trace(
                        `create${logName}OnSuccess::postTransform `
                        + '(make primary audio/video ssrcs consistent)',
                        dumpSDP(resultSdp));
                }

                // configure simulcast for camera tracks always and for
                // desktop tracks only when the testing flag for maxbitrates
                // in config.js is disabled.
                if (this.isSimulcastOn()
                    && (!this.options.capScreenshareBitrate
                        || (this.options.capScreenshareBitrate && hasCameraTrack(this)))) {
                    // eslint-disable-next-line no-param-reassign
                    resultSdp = this.simulcast.mungeLocalDescription(resultSdp);
                    this.trace(
                        `create${logName}`
                        + 'OnSuccess::postTransform (simulcast)',
                        dumpSDP(resultSdp));
                }

                if (!this.options.disableRtx && browser.supportsRtx()) {
                    // eslint-disable-next-line no-param-reassign
                    resultSdp = new RTCSessionDescription({
                        type: resultSdp.type,
                        sdp: this.rtxModifier.modifyRtxSsrcs(resultSdp.sdp)
                    });

                    this.trace(
                        `create${logName}`
                        + 'OnSuccess::postTransform (rtx modifier)',
                        dumpSDP(resultSdp));
                }
            }

            // Fix the setup attribute (see _fixAnswerRFC4145Setup for
            //  details)
            if (!isOffer) {
                const remoteDescription
                    = new SDP(this.remoteDescription.sdp);
                const localDescription = new SDP(resultSdp.sdp);

                _fixAnswerRFC4145Setup(remoteDescription, localDescription);

                // eslint-disable-next-line no-param-reassign
                resultSdp = new RTCSessionDescription({
                    type: resultSdp.type,
                    sdp: localDescription.raw
                });
            }

            const ssrcMap = extractSSRCMap(resultSdp);

            logger.debug('Got local SSRCs MAP: ', ssrcMap);
            this._processLocalSSRCsMap(ssrcMap);

            resolveFn(resultSdp);
        } catch (e) {
            this.trace(`create${logName}OnError`, e);
            this.trace(`create${logName}OnError`, dumpSDP(resultSdp));
            logger.error(`create${logName}OnError`, e, dumpSDP(resultSdp));

            rejectFn(e);
        }
    };

    const handleFailure = (err, rejectFn) => {
        this.trace(`create${logName}OnFailure`, err);
        const eventType
            = isOffer
                ? RTCEvents.CREATE_OFFER_FAILED
                : RTCEvents.CREATE_ANSWER_FAILED;

        this.eventEmitter.emit(eventType, err, this);

        rejectFn(err);
    };

    return new Promise((resolve, reject) => {
        let oaPromise;

        if (isOffer) {
            oaPromise = this.peerconnection.createOffer(constraints);
        } else {
            oaPromise = this.peerconnection.createAnswer(constraints);
        }

        oaPromise
            .then(
                sdp => handleSuccess(sdp, resolve, reject),
                error => handleFailure(error, reject));
    });
};

/**
 * Extract primary SSRC from given {@link TrackSSRCInfo} object.
 * @param {TrackSSRCInfo} ssrcObj
 * @return {number|null} the primary SSRC or <tt>null</tt>
 */
function extractPrimarySSRC(ssrcObj) {
    if (ssrcObj && ssrcObj.groups && ssrcObj.groups.length) {
        return ssrcObj.groups[0].ssrcs[0];
    } else if (ssrcObj && ssrcObj.ssrcs && ssrcObj.ssrcs.length) {
        return ssrcObj.ssrcs[0];
    }

    return null;
}

/**
 * Goes over the SSRC map extracted from the latest local description and tries
 * to match them with the local tracks (by MSID). Will update the values
 * currently stored in the {@link TraceableUnifiedPlanPeerConnection.localSSRCs} map.
 * @param {Map<string,TrackSSRCInfo>} ssrcMap
 * @private
 */
TraceableUnifiedPlanPeerConnection.prototype._processLocalSSRCsMap = function(ssrcMap) {
    for (const track of this.localTracks.values()) {
        const trackMSID = track.storedMSID;

        if (ssrcMap.has(trackMSID)) {
            const newSSRC = ssrcMap.get(trackMSID);

            if (!newSSRC) {
                logger.error(`No SSRC found for: ${trackMSID} in ${this}`);

                return;
            }
            const oldSSRC = this.localSSRCs.get(track.rtcId);
            const newSSRCNum = extractPrimarySSRC(newSSRC);
            const oldSSRCNum = extractPrimarySSRC(oldSSRC);

            // eslint-disable-next-line no-negated-condition
            if (newSSRCNum !== oldSSRCNum) {
                if (oldSSRCNum === null) {
                    logger.info(
                        `Storing new local SSRC for ${track} in ${this}`,
                        newSSRC);
                } else {
                    logger.error(
                        `Overwriting SSRC for ${track} ${trackMSID} in ${this
                        } with: `, newSSRC);
                }
                this.localSSRCs.set(track.rtcId, newSSRC);

                this.eventEmitter.emit(
                    RTCEvents.LOCAL_TRACK_SSRC_UPDATED, track, newSSRCNum);
            } else {
                logger.debug(
                    `The local SSRC(${newSSRCNum}) for ${track} ${trackMSID}`
                     + `is still up to date in ${this}`);
            }
        } else if (!track.isVideoTrack() && !track.isMuted()) {
            // It is normal to find no SSRCs for a muted video track in
            // the local SDP as the recv-only SSRC is no longer munged in.
            // So log the warning only if it's not a muted video track.
            logger.warn(`No SSRCs found in the local SDP for ${track} MSID: ${trackMSID} in ${this}`);
        }
    }
};

TraceableUnifiedPlanPeerConnection.prototype.addIceCandidate = function(candidate) {
    this.trace('addIceCandidate', JSON.stringify({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment
    }, null, ' '));

    return this.peerconnection.addIceCandidate(candidate);
};

/**
 * Obtains call-related stats from the peer connection.
 *
 * @param {Function} callback - The function to invoke after successfully
 * obtaining stats.
 * @param {Function} errback - The function to invoke after failing to obtain
 * stats.
 * @returns {void}
 */
TraceableUnifiedPlanPeerConnection.prototype.getStats = function(callback, errback) {
    // TODO (brian): After moving all browsers to adapter, check if adapter is
    // accounting for different getStats apis, making the browser-checking-if
    // unnecessary.
    if (browser.isSafariWithWebrtc() || browser.isFirefox()
            || browser.isReactNative()) {
        // uses the new Promise based getStats
        this.peerconnection.getStats()
            .then(callback)
            .catch(errback || (() => {

                // Making sure that getStats won't fail if error callback is
                // not passed.
            }));
    } else {
        this.peerconnection.getStats(callback);
    }
};

/**
 * Generates and stores new SSRC info object for given local track.
 * The method should be called only for a video track being added to this TPC
 * in the muted state (given that the current browser uses this strategy).
 * @param {JitsiLocalTrack} track
 * @return {TPCSSRCInfo}
 */
TraceableUnifiedPlanPeerConnection.prototype.generateNewStreamSSRCInfo = function(track) {
    const rtcId = track.rtcId;

    let ssrcInfo = this._getSSRC(rtcId);

    if (ssrcInfo) {
        logger.error(`Will overwrite local SSRCs for track ID: ${rtcId}`);
    }

    // configure simulcast for camera tracks always and for
    // desktop tracks only when the testing flag for maxbitrates
    // in config.js is disabled.
    if (this.isSimulcastOn()
        && (!this.options.capScreenshareBitrate
        || (this.options.capScreenshareBitrate && hasCameraTrack(this)))) {
        ssrcInfo = {
            ssrcs: [],
            groups: []
        };
        for (let i = 0; i < SIMULCAST_LAYERS; i++) {
            ssrcInfo.ssrcs.push(SDPUtil.generateSsrc());
        }
        ssrcInfo.groups.push({
            ssrcs: ssrcInfo.ssrcs.slice(),
            semantics: 'SIM'
        });
    } else {
        ssrcInfo = {
            ssrcs: [ SDPUtil.generateSsrc() ],
            groups: []
        };
    }
    if (!this.options.disableRtx && browser.supportsRtx()) {
        // Specifically use a for loop here because we'll
        //  be adding to the list we're iterating over, so we
        //  only want to iterate through the items originally
        //  on the list
        const currNumSsrcs = ssrcInfo.ssrcs.length;

        for (let i = 0; i < currNumSsrcs; ++i) {
            const primarySsrc = ssrcInfo.ssrcs[i];
            const rtxSsrc = SDPUtil.generateSsrc();

            ssrcInfo.ssrcs.push(rtxSsrc);
            ssrcInfo.groups.push({
                ssrcs: [ primarySsrc, rtxSsrc ],
                semantics: 'FID'
            });
        }
    }
    ssrcInfo.msid = track.storedMSID;
    this.localSSRCs.set(rtcId, ssrcInfo);

    return ssrcInfo;
};

const handleLayerSuspension = function(peerConnection, isSelected) {
    if (!peerConnection.getSenders) {
        logger.debug('Browser doesn\'t support RTPSender');

        return;
    }

    const videoSender = peerConnection.getSenders()
        .find(sender => sender.track.kind === 'video');

    if (!videoSender) {
        logger.warn('handleLayerSuspension unable to find video sender');

        return;
    }
    if (!videoSender.getParameters) {
        logger.debug('Browser doesn\'t support RTPSender parameters');

        return;
    }
    const parameters = videoSender.getParameters();

    if (isSelected) {
        logger.debug('Currently selected, enabling all sim layers');

        // Make sure all encodings are enabled
        parameters.encodings.forEach(e => {
            e.active = true;
        });
    } else {
        logger.debug('Not currently selected, disabling upper layers');

        // Turn off the upper simulcast layers
        [ 1, 2 ].forEach(simIndex => {
            if (parameters.encodings[simIndex]) {
                parameters.encodings[simIndex].active = false;
            }
        });
    }
    videoSender.setParameters(parameters);
};

/**
 * Set whether or not the endpoint is 'selected' by other endpoints, meaning
 * it appears on their main stage
 */
TraceableUnifiedPlanPeerConnection.prototype.setIsSelected = function(isSelected) {
    if (this.options.enableLayerSuspension) {
        logger.debug('Layer suspension enabled,'
            + `currently selected? ${isSelected}`);
        handleLayerSuspension(this.peerconnection, isSelected);
    }
};

/**
 * Creates a text representation of this <tt>TraceableUnifiedPlanPeerConnection</tt>
 * instance.
 * @return {string}
 */
TraceableUnifiedPlanPeerConnection.prototype.toString = function() {
    return `TPC[${this.id},p2p:${this.isP2P}]`;
};
