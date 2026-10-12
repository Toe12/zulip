import * as input_pill from "./input_pill.ts";
import * as people from "./people.ts";
import * as pill_typeahead from "./pill_typeahead.ts";
import * as user_pill from "./user_pill.ts";
import type {UserPill, UserPillWidget} from "./user_pill.ts";

// A todo task can be assigned to exactly one user, picked the same way
// as a direct message recipient. Bots, deactivated users and user
// groups are never offered.

export type TodoAssignee = {
    user_id: number;
    email: string;
};

function is_assignable(user_id: number): boolean {
    const user = people.maybe_get_user_by_id(user_id, true);
    return (
        user !== undefined &&
        !user.is_bot &&
        !user.is_inaccessible_user &&
        people.is_person_active(user_id)
    );
}

export function create($container: JQuery): UserPillWidget {
    const pills = input_pill.create<UserPill>({
        $container,
        pill_config: {exclude_inaccessible_users: true},
        create_item_from_text(text, existing_items, pill_config) {
            const item = user_pill.create_item_from_user_id(text, existing_items, pill_config);
            if (item === undefined || !is_assignable(item.user_id)) {
                return undefined;
            }
            return item;
        },
        get_text_from_item: user_pill.get_unique_full_name_from_item,
        get_display_value_from_item: user_pill.get_display_value_from_item,
        generate_pill_html: (item: UserPill) => user_pill.generate_pill_html(item),
    });

    // Only one assignee is allowed: a newly picked user replaces the
    // previous one.
    pills.onPillCreate(() => {
        const last_item = pills.items().at(-1);
        if (last_item !== undefined && pills.items().length > 1) {
            pills.clear(true);
            pills.appendValidatedData(last_item, false, true);
        }
    });

    pill_typeahead.set_up_user($container.find(".input"), pills, {exclude_bots: true});
    return pills;
}

export function get_assignee(pills: UserPillWidget): TodoAssignee | undefined {
    const item = pills.items()[0];
    if (item === undefined || !is_assignable(item.user_id)) {
        return undefined;
    }
    return {user_id: item.user_id, email: item.email};
}
