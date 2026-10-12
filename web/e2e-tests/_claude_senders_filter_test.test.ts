import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean): void {
    results.push(`${ok ? "PASS" : "FAIL"}: ${name}`);
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
}

async function open_search(page: Page): Promise<void> {
    await page.click(".search_icon");
    await page.waitForSelector(".navbar-search.expanded", {visible: true});
}

async function visual_test(page: Page): Promise<void> {
    await common.log_in(page);
    await page.waitForSelector("#left-sidebar", {visible: true});
    await common.screenshot(page, "step-1-logged-in");

    const hamlet_id = (await common.get_user_id_from_name(page, "King Hamlet"))!;
    const othello_id = (await common.get_user_id_from_name(page, "Othello, the Moor of Venice"))!;
    const desdemona_id = (await common.get_user_id_from_name(page, "Desdemona"))!;
    check(
        "found user ids",
        hamlet_id !== undefined && othello_id !== undefined && desdemona_id !== undefined,
    );

    // 1) The current user must appear in senders: suggestions
    // (unlike dm:, where self is implicit).
    await open_search(page);
    await common.clear_and_type(page, "#search_query", "senders:Desde");
    const self_entry = await page.waitForSelector(
        `xpath///*[${common.has_class_x("typeahead")}]//li[contains(normalize-space(), "Desdemona")]//a`,
        {visible: true},
    );
    check("current user suggested for senders:", self_entry !== null);
    await common.screenshot(page, "step-2-senders-suggests-self");

    // 2) Select King Hamlet as the first sender.
    await common.select_item_via_typeahead(page, "#search_query", "senders:King", "King Hamlet");
    await common.screenshot(page, "step-3-first-sender-pill");

    // 3) Type again: group suggestions should offer extending the
    // senders list with Othello.
    await common.select_item_via_typeahead(
        page,
        "#search_query",
        "Othello",
        "Othello, the Moor of Venice",
    );
    await common.screenshot(page, "step-4-two-sender-pill");

    // 4) Apply the narrow.
    await page.keyboard.press("Enter");
    await page.waitForSelector(".message-list .message_row", {visible: true});
    await common.screenshot(page, "step-5-narrowed-feed");

    // 5) Verify every rendered message is from one of the two senders,
    // and that both senders appear (OR semantics).
    const sender_ids: number[] = await page.evaluate(() =>
        zulip_test.current_msg_list!.all_messages().map((message) => message.sender_id),
    );
    check("narrow returned messages", sender_ids.length > 0);
    check(
        "all messages from the two selected senders",
        sender_ids.every((id) => id === hamlet_id || id === othello_id),
    );
    check(
        "messages from both senders present (OR semantics)",
        sender_ids.includes(hamlet_id) && sender_ids.includes(othello_id),
    );

    // 6) Verify the narrow survives a URL round-trip.
    const hash = await page.evaluate(() => window.location.hash);
    console.log(`narrow hash: ${hash}`);
    check("hash uses senders operator", hash.includes("/senders/"));
    await page.reload({waitUntil: "networkidle2"});
    await page.waitForSelector(".message-list .message_row", {visible: true});
    const sender_ids_after_reload: number[] = await page.evaluate(() =>
        zulip_test.current_msg_list!.all_messages().map((message) => message.sender_id),
    );
    check(
        "narrow restored from URL after reload",
        sender_ids_after_reload.length > 0 &&
            sender_ids_after_reload.every((id) => id === hamlet_id || id === othello_id),
    );
    await common.screenshot(page, "step-6-after-reload");

    // 7) "senders:me" resolves to the current user automatically.
    // Start from the combined feed so no previous pills linger.
    await page.goto("http://zulip.zulipdev.com:9981/#feed");
    await page.waitForSelector(".message-list .message_row", {visible: true});
    await open_search(page);
    await common.clear_and_type(page, "#search_query", "senders:me");
    const me_suggestion = await page.waitForSelector(
        `xpath///*[${common.has_class_x("typeahead")}]//li[contains(normalize-space(), "Desdemona")]//a`,
        {visible: true},
    );
    check("senders:me suggests the current user", me_suggestion !== null);
    await common.screenshot(page, "step-7-senders-me-typeahead");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.location.hash.includes("/senders/"));
    const me_hash = await page.evaluate(() => window.location.hash);
    console.log(`senders:me hash: ${me_hash}`);
    check(
        "senders:me narrow is exactly the current user",
        me_hash.startsWith(`#narrow/senders/${desdemona_id}-`),
    );
    const me_sender_ids: number[] = await page.evaluate(() =>
        zulip_test.current_msg_list!.all_messages().map((message) => message.sender_id),
    );
    check(
        "all messages in senders:me narrow are from the current user",
        me_sender_ids.every((id) => id === desdemona_id),
    );
    await common.screenshot(page, "step-8-senders-me-narrow");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(`Visual test failures:\n${failures.join("\n")}`);
    }
}

await common.run_test(visual_test);
