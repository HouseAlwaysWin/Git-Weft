/**
 * Opening an address outside VS Code, spelled exactly as it was built.
 */

import * as vscode from 'vscode';

/**
 * Open a web address in the browser, as it is spelled.
 *
 * Handed over as a string, though the API is typed for a Uri: VS Code opens a Uri by decoding it and
 * encoding it again, which turns an encoded `&`, `/` or `#` back into the separator it was encoded so
 * as not to be (microsoft/vscode#85930). A string it opens as it is.
 */
export function openUrl(url: string): Thenable<boolean> {
  return vscode.env.openExternal(url as unknown as vscode.Uri);
}
