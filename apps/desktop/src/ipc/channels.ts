export const SET_THEME_CHANNEL = "desktop:set-theme";
export const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
export const MENU_ACTION_CHANNEL = "desktop:menu-action";
export const GET_WINDOW_FULLSCREEN_STATE_CHANNEL = "desktop:get-window-fullscreen-state";
export const WINDOW_FULLSCREEN_STATE_CHANNEL = "desktop:window-fullscreen-state";
export const GET_APP_BRANDING_CHANNEL = "desktop:get-app-branding";
export const GET_CLIENT_SETTINGS_CHANNEL = "desktop:get-client-settings";
export const SET_CLIENT_SETTINGS_CHANNEL = "desktop:set-client-settings";
export const GET_KEYBINDINGS_CHANNEL = "desktop:get-keybindings";
export const SET_KEYBINDINGS_CHANNEL = "desktop:set-keybindings";
export const OPEN_KEYBINDINGS_FILE_CHANNEL = "desktop:open-keybindings-file";
export const OPEN_DOCUMENT_DIALOG_CHANNEL = "desktop:open-document-dialog";
export const OPEN_RECENT_DOCUMENT_CHANNEL = "desktop:open-recent-document";
export const GET_RECENT_DOCUMENTS_CHANNEL = "desktop:get-recent-documents";
export const CLEAR_RECENT_DOCUMENTS_CHANNEL = "desktop:clear-recent-documents";
export const RECENT_DOCUMENTS_CHANNEL = "desktop:recent-documents";
export const RECORD_OPENED_PATH_CHANNEL = "desktop:record-opened-path";
export const DOCUMENTS_READY_CHANNEL = "desktop:documents-ready";
/** Main to renderer: a `DesktopOpenedDocument` with one MessagePort that reads the file. */
export const DOCUMENT_SOURCE_CHANNEL = "desktop:document-source";
/** The renderer posts `{ path }` with one MessagePort; the main process streams the save over it. */
export const SAVE_DOCUMENT_CHANNEL = "desktop:save-document";
export const DOCUMENT_PATH_CHANNEL = "desktop:document-path";
export const DOCUMENT_STAMP_CHANNEL = "desktop:document-stamp";
export const SAVE_DOCUMENT_DIALOG_CHANNEL = "desktop:save-document-dialog";
export const OPEN_DOCUMENT_PATH_CHANNEL = "desktop:open-document-path";
/** One journal store operation (JournalStoreRequest) against the state directory, answered over invoke. */
export const JOURNAL_CHANNEL = "desktop:journal";
/** Main to renderer: may the window close? Sent with a request id while the close is held. */
export const CLOSE_REQUEST_CHANNEL = "desktop:close-request";
/** Renderer to main: `{ id, close }`, the page's answer to a close request. */
export const CLOSE_REPLY_CHANNEL = "desktop:close-reply";
/** Main to renderer: a `DesktopOpenFailure` for a file the main process could not open. */
export const DOCUMENT_OPEN_FAILED_CHANNEL = "desktop:document-open-failed";
export const REMOVE_RECENT_DOCUMENT_CHANNEL = "desktop:remove-recent-document";
