/**
 * Shared form fields for the Model Http Proxy settings page: one labelled
 * text field and a hostname combobox (free text + suggestions dropdown).
 */
import type { HostSuggestion } from './settings-io.js';
export declare function ValueField(props: {
    id: string;
    label: string;
    hint: string;
    placeholder: string;
    value: string;
    disabled: boolean;
    onEdit: (text: string) => void;
}): import("react").JSX.Element;
/**
 * A hostname field that behaves like the host's own tag inputs: every
 * committed host is drawn as a removable chip, and the text cursor lives in a
 * bare input at the end of the row. Focus (or the chevron) opens a dropdown of
 * the providers that are actually configured. Enter or a comma commits what is
 * typed, Backspace on an empty entry drops the last chip, Arrow keys move the
 * highlight, Enter picks a suggestion, Escape closes the list.
 *
 * The chips are the value: `value` is the parsed host list and `onChange`
 * always hands back a whole new list, so the page never has to split text.
 */
export declare function HostField(props: {
    id: string;
    label: string;
    hint: string;
    placeholder: string;
    value: string[];
    suggestions: HostSuggestion[];
    disabled: boolean;
    onChange: (next: string[]) => void;
}): import("react").JSX.Element;
//# sourceMappingURL=fields.d.ts.map