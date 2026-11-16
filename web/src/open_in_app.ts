// A link into a conversation, like `https://example.com/#narrow/id/123`,
// that is typed or pasted into a phone's browser is opened as a web page,
// since the system only hands a link over to an app when it is tapped in
// another app.  So when a mobile browser loads such a page, we send it on to
// the mobile app, using the app's own URL scheme.
const APP_SCHEME = "basecomms";

const MOBILE_USER_AGENT_REGEX = /android|iphone|ipad|ipod/i;

// Whether we have already tried this link in this browser tab.  Without
// this, coming back to the browser from the app would send us back again,
// and a phone without the app would be asked on every reload.
const TRIED_LINK_STORAGE_KEY = "open_in_app_tried_link";

export function get_app_link(url: URL, user_agent: string): string | undefined {
    if (!MOBILE_USER_AGENT_REGEX.test(user_agent)) {
        return undefined;
    }
    // Other pages, like the help center, belong in the browser.
    if (!["/", "/login", "/login/"].includes(url.pathname)) {
        return undefined;
    }
    if (url.hash.split("/")[0] !== "#narrow") {
        return undefined;
    }
    return `${APP_SCHEME}://${url.host}${url.pathname}${url.hash}`;
}

export function open_in_app_if_mobile(): void {
    const app_link = get_app_link(new URL(window.location.href), window.navigator.userAgent);
    if (app_link === undefined) {
        return;
    }
    try {
        if (window.sessionStorage.getItem(TRIED_LINK_STORAGE_KEY) === app_link) {
            return;
        }
        window.sessionStorage.setItem(TRIED_LINK_STORAGE_KEY, app_link);
    } catch {
        // Storage can be unavailable, like in a private window.
        // Trying the link once more than needed is harmless.
    }
    window.location.href = app_link;
}
