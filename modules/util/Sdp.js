/* globals RTCPeerConnection, RTCRtpTransceiver */

const flatMap = require('./FlatMap').flatMap;
const guessBrowser = require('./Browser').guessBrowser;

// NOTE(mmalavalli): We cache Chrome's sdpSemantics support in order to prevent
// instantiation of more than one RTCPeerConnection.
let isSdpSemanticsSupported = null;

/**
 * Check if Chrome supports specifying sdpSemantics for an RTCPeerConnection.
 * @return {boolean}
 */
export function checkIfSdpSemanticsIsSupported() {
    if (typeof isSdpSemanticsSupported === 'boolean') {
        return isSdpSemanticsSupported;
    }
    if (typeof RTCPeerConnection === 'undefined') {
        isSdpSemanticsSupported = false;

        return isSdpSemanticsSupported;
    }
    try {
        // eslint-disable-next-line no-new
        new RTCPeerConnection({ sdpSemantics: 'foo' });
        isSdpSemanticsSupported = false;
    } catch (e) {
        isSdpSemanticsSupported = true;
    }

    return isSdpSemanticsSupported;
}

// NOTE(mmalavalli): We cache Chrome's SDP format in order to prevent
// instantiation of more than one RTCPeerConnection.
let chromeSdpFormat = null;

/**
 * Get Chrome's default SDP format.
 * @returns {'planb'|'unified'}
 */
export function getChromeDefaultSdpFormat() {
    if (!chromeSdpFormat) {
        if (typeof RTCPeerConnection !== 'undefined'
            && 'addTransceiver' in RTCPeerConnection.prototype) {
            try {
                new RTCPeerConnection().addTransceiver('audio');
                chromeSdpFormat = 'unified';
            } catch (e) {
                chromeSdpFormat = 'planb';
            }
        } else {
            chromeSdpFormat = 'planb';
        }
    }

    return chromeSdpFormat;
}

/**
 * Get Chrome's SDP format.
 * @param {'plan-b'|'unified-plan'} [sdpSemantics]
 * @returns {'planb'|'unified'}
 */
export function getChromeSdpFormat(sdpSemantics) {
    if (!sdpSemantics || !checkIfSdpSemanticsIsSupported()) {
        return getChromeDefaultSdpFormat();
    }

    return {
        'plan-b': 'planb',
        'unified-plan': 'unified'
    }[sdpSemantics];
}

/**
 * Get Safari's default SDP format.
 * @returns {'planb'|'unified'}
 */
export function getSafariSdpFormat() {
    return typeof RTCRtpTransceiver !== 'undefined'
    && 'currentDirection' in RTCRtpTransceiver.prototype
        ? 'unified'
        : 'planb';
}

/**
 * Get the browser's default SDP format.
 * @param {'plan-b'|'unified-plan'} [sdpSemantics]
 * @returns {'planb'|'unified'}
 */
export function getSdpFormat(sdpSemantics) {
    return {
        chrome: getChromeSdpFormat(sdpSemantics),
        firefox: 'unified',
        safari: getSafariSdpFormat()
    }[guessBrowser()] || null;
}

/**
 * Match a pattern across lines, returning the first capture group for any
 * matches.
 * @param {string} pattern
 * @param {string} lines
 * @returns {Set<string>} matches
 */
export function getMatches(pattern, lines) {
    const matches = lines.match(new RegExp(pattern, 'gm')) || [];

    return matches.reduce((results, line) => {
        const match = line.match(new RegExp(pattern));

        return match ? results.add(match[1]) : results;
    }, new Set());
}


export function getGroups(pattern, lines) {
    const matches = lines.match(new RegExp(pattern, 'gm')) || [];

    return matches.reduce((results, line) => {
        const match = line.match(new RegExp(pattern));

        return match ? results.add(match[1]) : results;
    }, new Set());
}
/**
 * Get a Set of MediaStreamTrack IDs from an SDP.
 * @param {string} pattern
 * @param {string} sdp
 * @returns {Set<string>}
 */
export function getTrackIds(pattern, sdp) {
    return getMatches(pattern, sdp);
}

/**
 * Get a Set of MediaStreamTrack IDs from a Plan B SDP.
 * @param {string} sdp - Plan B SDP
 * @returns {Set<string>} trackIds
 */
export function getPlanBTrackIds(sdp) {
    return getTrackIds('^a=ssrc:[0-9]+ +msid:.+ +(.+) *$', sdp);
}

/**
 * Get a Set of MediaStreamTrack IDs from a Unified Plan SDP.
 * @param {string} sdp - Unified Plan SDP
 * @returns {Set<string>} trackIds
 */
export function getUnifiedPlanTrackIds(sdp) {
    return getTrackIds('^a=msid:.+ +(.+) *$', sdp);
}

/**
 * Get a Set of SSRCs for a MediaStreamTrack from a Plan B SDP.
 * @param {string} sdp - Plan B SDP
 * @param {string} trackId - MediaStreamTrack ID
 * @returns {Set<string>}
 */
export function getPlanBSSRCs(sdp, trackId) {
    const pattern = `^a=ssrc:([0-9]+) +msid:[^ ]+ +${trackId} *$`;

    return getMatches(pattern, sdp);
}

/**
 * Get the m= sections of a particular kind and direction from an sdp.
 * @param {string} sdp -  sdp string
 * @param {string} [kindParam] - Pattern for matching kind
 * @param {string} [directionParam] - Pattern for matching direction
 * @returns {Array<string>} mediaSections
 */
export function getMediaSections(sdp, kindParam, directionParam) {
    const kind = kindParam || '.*';
    const direction = directionParam || '.*';

    return sdp
        .split('\r\nm=')
        .slice(1)
        .map(mediaSection => `m=${mediaSection}`)
        .filter(mediaSection => {
            const kindPattern = new RegExp(`m=${kind}`, 'gm');
            const directionPattern = new RegExp(`a=${direction}`, 'gm');

            return kindPattern.test(mediaSection) && directionPattern.test(mediaSection);
        });
}

/**
 * Get the Set of SSRCs announced in a MediaSection.
 * @param {string} mediaSection
 * @returns {Array<string>} ssrcs
 */
export function getMediaSectionSSRCs(mediaSection) {
    return Array.from(getMatches('^a=ssrc:([0-9]+) +.*$', mediaSection));
}

/**
 * Get a Set of SSRCs for a MediaStreamTrack from a Unified Plan SDP.
 * @param {string} sdp - Unified Plan SDP
 * @param {string} trackId - MediaStreamTrack ID
 * @returns {Set<string>}
 */
export function getUnifiedPlanSSRCs(sdp, trackId) {
    const mediaSections = getMediaSections(sdp);

    const msidAttrRegExp = new RegExp(`^a=msid:[^ ]+ +${trackId} *$`, 'gm');
    const matchingMediaSections = mediaSections.filter(mediaSection => mediaSection.match(msidAttrRegExp));

    return new Set(flatMap(matchingMediaSections, getMediaSectionSSRCs));
}

/**
 * Get a Map from MediaStreamTrack IDs to SSRCs from an SDP.
 * @param {function(string): Set<string>} getTrackIdsFk
 * @param {function(string, string): Set<string>} getSSRCs
 * @param {string} sdp - SDP
 * @returns {Map<string, Set<string>>} trackIdsToSSRCs
 */
export function getTrackIdsToSSRCs(getTrackIdsFk, getSSRCs, sdp) {
    return new Map(Array.from(getTrackIdsFk(sdp)).map(trackId => [ trackId, getSSRCs(sdp, trackId) ]));
}

/**
 * Get a Map from MediaStreamTrack IDs to SSRCs from a Plan B SDP.
 * @param {string} sdp - Plan B SDP
 * @returns {Map<string, Set<string>>} trackIdsToSSRCs
 */
export function getPlanBTrackIdsToSSRCs(sdp) {
    return getTrackIdsToSSRCs(getPlanBTrackIds, getPlanBSSRCs, sdp);
}

/**
 * Get a Map from MediaStreamTrack IDs to SSRCs from a Plan B SDP.
 * @param {string} sdp - Plan B SDP
 * @returns {Map<string, Set<string>>} trackIdsToSSRCs
 */
export function getUnifiedPlanTrackIdsToSSRCs(sdp) {
    return getTrackIdsToSSRCs(getUnifiedPlanTrackIds, getUnifiedPlanSSRCs, sdp);
}

/**
 * Update the mappings from MediaStreamTrack IDs to SSRCs as indicated by both
 * the Map from MediaStreamTrack IDs to SSRCs and the SDP itself. This method
 * ensures that SSRCs never change once announced.
 * @param {function(string): Map<string, Set<string>>} getTrackIdsToSSRCsFk
 * @param {Map<string, Set<string>>} trackIdsToSSRCs
 * @param {string} sdp - SDP
 * @returns {strinng} updatedSdp - updated SDP
 */
export function updateTrackIdsToSSRCs(getTrackIdsToSSRCsFk, trackIdsToSSRCs, sdp) {
    const newTrackIdsToSSRCs = getTrackIdsToSSRCsFk(sdp);
    const newSSRCsToOldSSRCs = new Map();

    let newSdp = sdp;

    // NOTE(mroberts): First, update a=ssrc attributes.
    newTrackIdsToSSRCs.forEach((ssrcs, trackId) => {
        if (!trackIdsToSSRCs.has(trackId)) {
            trackIdsToSSRCs.set(trackId, ssrcs);

            return;
        }
        const oldSSRCs = Array.from(trackIdsToSSRCs.get(trackId));
        const newSSRCs = Array.from(ssrcs);

        oldSSRCs.forEach((oldSSRC, i) => {
            const newSSRC = newSSRCs[i];

            newSSRCsToOldSSRCs.set(newSSRC, oldSSRC);
            const pattern = `^a=ssrc:${newSSRC} (.*)$`;
            const replacement = `a=ssrc:${oldSSRC} $1`;

            newSdp = sdp.replace(new RegExp(pattern, 'gm'), replacement);
        });
    });

    // NOTE(mroberts): Then, update a=ssrc-group attributes.
    const pattern = '^(a=ssrc-group:[^ ]+ +)(.*)$';
    const matches = newSdp.match(new RegExp(pattern, 'gm')) || [];

    matches.forEach(line => {
        const match = line.match(new RegExp(pattern));

        if (!match) {
            return;
        }
        const prefix = match[1];
        const newSSRCs = match[2];
        const oldSSRCs = newSSRCs
            .split(' ')
            .map(newSSRC => {
                const oldSSRC = newSSRCsToOldSSRCs.get(newSSRC);

                return oldSSRC ? oldSSRC : newSSRC;
            })
            .join(' ');

        newSdp = newSdp.replace(match[0], prefix + oldSSRCs);
    });

    return sdp;
}

/**
 * Update the mappings from MediaStreamTrack IDs to SSRCs as indicated by both
 * the Map from MediaStreamTrack IDs to SSRCs and the Plan B SDP itself. This
 * method ensures that SSRCs never change once announced.
 * @param {Map<string, Set<string>>} trackIdsToSSRCs
 * @param {string} sdp - Plan B SDP
 * @returns {string} updatedSdp - updated Plan B SDP
 */
export function updatePlanBTrackIdsToSSRCs(trackIdsToSSRCs, sdp) {
    return updateTrackIdsToSSRCs(getPlanBTrackIdsToSSRCs, trackIdsToSSRCs, sdp);
}

/**
 * Update the mappings from MediaStreamTrack IDs to SSRCs as indicated by both
 * the Map from MediaStreamTrack IDs to SSRCs and the Plan B SDP itself. This
 * method ensures that SSRCs never change once announced.
 * @param {Map<string, Set<string>>} trackIdsToSSRCs
 * @param {string} sdp - Plan B SDP
 * @returns {string} updatedSdp - updated Plan B SDP
 */
export function updateUnifiedPlanTrackIdsToSSRCs(trackIdsToSSRCs, sdp) {
    return updateTrackIdsToSSRCs(getUnifiedPlanTrackIdsToSSRCs, trackIdsToSSRCs, sdp);
}
