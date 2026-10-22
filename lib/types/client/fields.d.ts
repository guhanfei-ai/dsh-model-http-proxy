/**
 * Shared form fields for the Model Http Proxy settings page: one labelled
 * text field and a hostname combobox (free text + suggestions dropdown).
 */
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
 * A hostname field that doubles as a combobox: it stays free text, but focus
 * (or a chevron) opens a dropdown of known model hostnames to pick from,
 * styled like the host's own menus rather than a browser dialog. Arrow keys
 * move the highlight, Enter picks, Escape closes.
 */
export declare function HostField(props: {
    id: string;
    label: string;
    hint: string;
    placeholder: string;
    value: string;
    suggestions: string[];
    disabled: boolean;
    onEdit: (text: string) => void;
}): import("react").JSX.Element;
//# sourceMappingURL=fields.d.ts.map