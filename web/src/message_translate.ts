// On-demand translation of messages (and to-do list widgets) between
// English, Spanish and Indonesian, through POST
// /json/messages/{id}/translate (local addition; the server talks to a
// LibreTranslate instance on localhost).
//
// The translation replaces the message content in place, with a bar
// above it to switch back to the original or pick another language.
// State lives here, keyed by message id, so it survives re-renders of
// the message list (message_list_view calls restore() after rendering
// each row) and of the to-do widget (which calls todo_text()).

import $ from "jquery";
import * as z from "zod/mini";

import * as channel from "./channel.ts";
import {localstorage} from "./localstorage.ts";
import * as message_lists from "./message_lists.ts";
import * as message_store from "./message_store.ts";
import {page_params} from "./page_params.ts";
import * as rendered_markdown from "./rendered_markdown.ts";
import * as rows from "./rows.ts";
import {user_settings} from "./user_settings.ts";

const LANGUAGES = ["en", "es", "id"] as const;
type Lang = (typeof LANGUAGES)[number];

const LANGUAGE_SET: ReadonlySet<unknown> = new Set(LANGUAGES);

function is_lang(value: unknown): value is Lang {
    return LANGUAGE_SET.has(value);
}

// The bar is written in the language being translated into, which is
// the language the reader understands. (Zulip's own i18n catalogs don't
// have these strings.)
const UI_TEXT: Record<
    Lang,
    {
        names: Record<Lang, string>;
        translated_from: (lang: string) => string;
        already_in: (lang: string) => string;
        show_original: string;
        show_translation: string;
        translating: string;
        failed: string;
        close: string;
        translate_to: string;
    }
> = {
    en: {
        names: {en: "English", es: "Spanish", id: "Indonesian"},
        translated_from: (lang) => `Translated from ${lang}`,
        already_in: (lang) => `Already in ${lang}`,
        show_original: "Show original",
        show_translation: "Show translation",
        translating: "Translating…",
        failed: "Translation failed",
        close: "Close translation",
        translate_to: "Translate to",
    },
    es: {
        names: {en: "inglés", es: "español", id: "indonesio"},
        translated_from: (lang) => `Traducido del ${lang}`,
        already_in: (lang) => `Ya está en ${lang}`,
        show_original: "Ver original",
        show_translation: "Ver traducción",
        translating: "Traduciendo…",
        failed: "No se pudo traducir",
        close: "Cerrar traducción",
        translate_to: "Traducir a",
    },
    id: {
        names: {en: "Inggris", es: "Spanyol", id: "Indonesia"},
        translated_from: (lang) => `Diterjemahkan dari bahasa ${lang}`,
        already_in: (lang) => `Sudah dalam bahasa ${lang}`,
        show_original: "Lihat asli",
        show_translation: "Lihat terjemahan",
        translating: "Menerjemahkan…",
        failed: "Gagal menerjemahkan",
        close: "Tutup terjemahan",
        translate_to: "Terjemahkan ke",
    },
};

const translate_response_schema = z.object({
    source: z.nullable(z.string()),
    target: z.string(),
    same_language: z.boolean(),
    content: z.nullable(z.string()),
    strings: z.nullable(z.record(z.string(), z.string())),
});

type TranslationState = {
    target: Lang;
    status: "loading" | "ready" | "same" | "error";
    source: Lang | undefined;
    // Translated HTML, for regular messages.
    content: string | undefined;
    // {original: translation}, for to-do lists.
    strings: Map<string, string>;
    show_original: boolean;
    // message.content when the translation was requested, to notice edits.
    original_content: string;
    error_message: string | undefined;
    // To-do strings already sent to the server, so that a string the
    // server doesn't translate doesn't cause a request loop.
    requested: Set<string>;
    refresh_timer: ReturnType<typeof setTimeout> | undefined;
    request_id: number;
};

const states = new Map<number, TranslationState>();
const todo_rerenders = new Map<number, () => void>();
// To-do widgets that must be re-rendered once to drop their translations.
const todo_needs_original = new Set<number>();
let next_request_id = 0;

const TARGET_STORAGE_KEY = "message_translate_target";

export function preferred_target(): Lang {
    try {
        if (localstorage.supported()) {
            const stored: unknown = localstorage().get(TARGET_STORAGE_KEY);
            if (is_lang(stored)) {
                return stored;
            }
        }
    } catch {
        // Storage can be unavailable; fall back to the UI language.
    }
    const ui_language = user_settings.default_language.split(/[-_]/)[0];
    return is_lang(ui_language) ? ui_language : "en";
}

function save_preferred_target(target: Lang): void {
    try {
        if (localstorage.supported()) {
            localstorage().set(TARGET_STORAGE_KEY, target);
        }
    } catch {
        // Not important enough to report.
    }
}

export function is_translated(message_id: number): boolean {
    return states.has(message_id);
}

function is_hidden(message_id: number): boolean {
    return message_lists.current?.view.message_containers.get(message_id)?.is_hidden ?? false;
}

function request_translation(message_id: number, state: TranslationState): void {
    next_request_id += 1;
    const request_id = next_request_id;
    state.request_id = request_id;
    void channel.post({
        url: `/json/messages/${message_id}/translate`,
        data: {target: state.target},
        success(raw_data) {
            if (states.get(message_id) !== state || state.request_id !== request_id) {
                // Closed, or superseded by a newer request.
                return;
            }
            const data = translate_response_schema.parse(raw_data);
            state.source = is_lang(data.source) ? data.source : undefined;
            if (data.same_language) {
                state.status = "same";
            } else {
                state.status = "ready";
                state.content = data.content ?? undefined;
                for (const [original, translation] of Object.entries(data.strings ?? {})) {
                    state.strings.set(original, translation);
                }
            }
            render(message_id);
        },
        error(xhr) {
            if (states.get(message_id) !== state || state.request_id !== request_id) {
                return;
            }
            state.status = "error";
            const parsed = z.object({msg: z.string()}).safeParse(xhr.responseJSON);
            state.error_message = parsed.success ? parsed.data.msg : undefined;
            render(message_id);
        },
    });
}

export function translate(message_id: number, target: Lang = preferred_target()): void {
    const message = message_store.get(message_id);
    if (message === undefined || page_params.is_spectator) {
        return;
    }
    const old_state = states.get(message_id);
    if (old_state?.refresh_timer !== undefined) {
        clearTimeout(old_state.refresh_timer);
    }
    const state: TranslationState = {
        target,
        status: "loading",
        source: undefined,
        content: undefined,
        strings: new Map(),
        show_original: false,
        original_content: message.content,
        error_message: undefined,
        requested: new Set(),
        refresh_timer: undefined,
        request_id: 0,
    };
    states.set(message_id, state);
    render(message_id);
    request_translation(message_id, state);
}

export function close(message_id: number): void {
    const state = states.get(message_id);
    if (state?.refresh_timer !== undefined) {
        clearTimeout(state.refresh_timer);
    }
    states.delete(message_id);
    todo_needs_original.add(message_id);
    render(message_id);
}

export function toggle(message_id: number): void {
    if (states.has(message_id)) {
        close(message_id);
    } else {
        translate(message_id);
    }
}

function render(message_id: number): void {
    const $row = message_lists.current?.get_row(message_id);
    if ($row !== undefined && $row.length > 0) {
        restore($row, message_id);
    }
}

function build_bar(message_id: number, state: TranslationState): JQuery {
    const text = UI_TEXT[state.target];
    const $bar = $("<div>")
        .addClass("message-translation-bar no-select")
        .attr("data-message-id", message_id);
    $bar.append($("<i>").addClass("zulip-icon zulip-icon-globe").attr("aria-hidden", "true"));

    let status_text: string;
    switch (state.status) {
        case "loading":
            status_text = text.translating;
            break;
        case "error":
            status_text = text.failed;
            break;
        case "same":
            status_text = text.already_in(text.names[state.target]);
            break;
        case "ready":
            status_text =
                state.source === undefined
                    ? text.translated_from("?")
                    : text.translated_from(text.names[state.source]);
            break;
    }
    const $status = $("<span>").addClass("message-translation-status").text(status_text);
    if (state.status === "error" && state.error_message !== undefined) {
        $status.attr("title", state.error_message);
    }
    $bar.append($status);

    if (state.status === "ready") {
        $bar.append($("<span>").addClass("message-translation-separator").text("·"));
        $bar.append(
            $("<a>")
                .addClass("message-translation-toggle")
                .attr({role: "button", tabindex: "0"})
                .text(state.show_original ? text.show_translation : text.show_original),
        );
    }

    $bar.append($("<span>").addClass("message-translation-separator").text("·"));
    const $select = $("<select>")
        .addClass("message-translation-target")
        .attr({"aria-label": text.translate_to, title: text.translate_to});
    for (const lang of LANGUAGES) {
        $select.append(
            $("<option>")
                .val(lang)
                .text(lang.toUpperCase())
                .prop("selected", lang === state.target),
        );
    }
    $bar.append($select);

    $bar.append(
        $("<a>")
            .addClass("message-translation-close")
            .attr({role: "button", tabindex: "0", "aria-label": text.close, title: text.close})
            .append($("<i>").addClass("zulip-icon zulip-icon-close").attr("aria-hidden", "true")),
    );
    return $bar;
}

// Applies the current translation state to a rendered message row.
// Called after the row is (re)rendered, and after the state changes.
export function restore($row: JQuery, message_id: number): void {
    $row.find(".message-translation-bar").remove();
    const $content = $row.find(".message_content").first();
    const message = message_store.get(message_id);
    const state = states.get(message_id);
    const has_widget = $content.find(".widget-content").length > 0;

    const show_translation = state?.status === "ready" && !state.show_original;

    if (!has_widget) {
        const is_showing_translation = $content.attr("data-translated") === "true";
        if (show_translation && state.content !== undefined) {
            $content.html(state.content);
            $content.attr("data-translated", "true");
            rendered_markdown.update_elements($content);
        } else if (is_showing_translation && message !== undefined) {
            $content.html(message.content);
            $content.removeAttr("data-translated");
            rendered_markdown.update_elements($content);
        }
    }

    if (state === undefined || message === undefined || is_hidden(message_id)) {
        if (has_widget && todo_needs_original.delete(message_id)) {
            todo_rerenders.get(message_id)?.();
        }
        return;
    }

    if (message.content !== state.original_content && state.status !== "loading") {
        // The message was edited since it was translated.
        translate(message_id, state.target);
        return;
    }

    const $bar = build_bar(message_id, state);
    $content.prepend($bar);
    if (has_widget) {
        todo_rerenders.get(message_id)?.();
    }
}

// Called by the to-do widget each time it renders, so that changing the
// translation state can re-render the widget's title and tasks.
export function register_todo_rerender(message_id: number, rerender: () => void): void {
    todo_rerenders.set(message_id, rerender);
}

function schedule_todo_refresh(message_id: number, state: TranslationState): void {
    if (state.refresh_timer !== undefined) {
        return;
    }
    state.refresh_timer = setTimeout(() => {
        state.refresh_timer = undefined;
        if (states.get(message_id) === state) {
            request_translation(message_id, state);
        }
    }, 500);
}

// The text a to-do widget should display for a title, task name or
// description: its translation while the list is being shown translated.
export function todo_text(message_id: number, text: string): string {
    const state = states.get(message_id);
    if (state?.status !== "ready" || state.show_original || text === "") {
        return text;
    }
    const translation = state.strings.get(text);
    if (translation !== undefined) {
        return translation;
    }
    if (!state.requested.has(text)) {
        // A task added or edited after the list was translated.
        state.requested.add(text);
        schedule_todo_refresh(message_id, state);
    }
    return text;
}

export function initialize(): void {
    $("body").on("click", ".translate_message_button", function (this: HTMLElement, e) {
        e.stopPropagation();
        e.preventDefault();
        toggle(rows.get_message_id(this));
    });

    $("body").on("click", ".message-translation-bar", (e) => {
        // Don't let clicks on the bar select the message or open the
        // compose box.
        e.stopPropagation();
    });

    $("body").on("click keydown", ".message-translation-toggle", (e) => {
        if (e.type === "keydown" && e.key !== "Enter") {
            return;
        }
        e.preventDefault();
        const message_id = Number(
            $(e.currentTarget).closest(".message-translation-bar").attr("data-message-id"),
        );
        const state = states.get(message_id);
        if (state === undefined) {
            return;
        }
        state.show_original = !state.show_original;
        render(message_id);
    });

    $("body").on("click keydown", ".message-translation-close", (e) => {
        if (e.type === "keydown" && e.key !== "Enter") {
            return;
        }
        e.preventDefault();
        close(
            Number($(e.currentTarget).closest(".message-translation-bar").attr("data-message-id")),
        );
    });

    $("body").on("keydown", ".message-translation-target", (e) => {
        // Keep Zulip's hotkeys from reacting to arrow keys and letters.
        e.stopPropagation();
    });

    $("body").on("change", ".message-translation-target", (e) => {
        const value: unknown = $(e.currentTarget).val();
        if (!is_lang(value)) {
            return;
        }
        save_preferred_target(value);
        translate(
            Number($(e.currentTarget).closest(".message-translation-bar").attr("data-message-id")),
            value,
        );
    });
}
