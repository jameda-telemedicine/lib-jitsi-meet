/**
 * Get the browser's user agent, if available.
 * @returns {?string}
 */
export function getUserAgent() {
    return typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : null;
}

/**
 * Guess the browser.
 * @param {string} [userAgent=navigator.userAgent]
 * @returns {?string} browser - "chrome", "firefox", "safari", or null
 */
export function guessBrowser(userAgent) {
    let newUserAgent = userAgent;

    if (typeof newUserAgent === 'undefined') {
        newUserAgent = getUserAgent();
    }
    if (/Chrome|CriOS/.test(newUserAgent)) {
        return 'chrome';
    }
    if (/Firefox|FxiOS/.test(newUserAgent)) {
        return 'firefox';
    }
    if (/Safari/.test(newUserAgent)) {
        return 'safari';
    }

    return null;
}