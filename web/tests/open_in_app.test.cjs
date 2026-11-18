"use strict";

const assert = require("node:assert/strict");

const {set_global, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const {get_app_link, open_in_app_if_mobile} = zrequire("open_in_app");

const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36";
const desktop =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";

run_test("get_app_link", () => {
    const link = (url, user_agent) => get_app_link(new URL(url), user_agent);

    assert.equal(
        link("https://basecomms.com/#narrow/id/488", iphone),
        "basecomms://basecomms.com/#narrow/id/488",
    );
    assert.equal(
        link("https://basecomms.com/login/#narrow/id/488", android),
        "basecomms://basecomms.com/login/#narrow/id/488",
    );
    assert.equal(
        link("https://chat.example:9991/#narrow/channel/7-general/topic/hi", iphone),
        "basecomms://chat.example:9991/#narrow/channel/7-general/topic/hi",
    );

    // Not on a phone.
    assert.equal(link("https://basecomms.com/#narrow/id/488", desktop), undefined);
    // Not a narrow.
    assert.equal(link("https://basecomms.com/", iphone), undefined);
    assert.equal(link("https://basecomms.com/#settings/profile", iphone), undefined);
    assert.equal(link("https://basecomms.com/#narrowing/foo", iphone), undefined);
    // Not a page of the web app that we open in the app.
    assert.equal(link("https://basecomms.com/help/#narrow/id/1", iphone), undefined);
});

run_test("open_in_app_if_mobile", () => {
    const storage = new Map();
    const window = {
        location: {href: "https://basecomms.com/#narrow/id/488"},
        navigator: {userAgent: iphone},
        sessionStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem(key, value) {
                storage.set(key, value);
            },
        },
    };
    set_global("window", window);

    // The page is sent on to the app...
    open_in_app_if_mobile();
    assert.equal(window.location.href, "basecomms://basecomms.com/#narrow/id/488");

    // ...but only once for a link.
    window.location.href = "https://basecomms.com/#narrow/id/488";
    open_in_app_if_mobile();
    assert.equal(window.location.href, "https://basecomms.com/#narrow/id/488");

    // A different link is tried.
    window.location.href = "https://basecomms.com/#narrow/id/489";
    open_in_app_if_mobile();
    assert.equal(window.location.href, "basecomms://basecomms.com/#narrow/id/489");

    // Without usable storage, the link is still tried.
    window.sessionStorage = {
        getItem() {
            throw new Error("storage unavailable");
        },
    };
    window.location.href = "https://basecomms.com/#narrow/id/490";
    open_in_app_if_mobile();
    assert.equal(window.location.href, "basecomms://basecomms.com/#narrow/id/490");

    // A page that isn't a narrow is left alone.
    window.location.href = "https://basecomms.com/#settings/profile";
    open_in_app_if_mobile();
    assert.equal(window.location.href, "https://basecomms.com/#settings/profile");
});
