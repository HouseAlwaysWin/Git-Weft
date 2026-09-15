/**
 * The statistics tab: commits per person, and over time, in what the graph of a repository walked.
 *
 * It asks git nothing. The graph's walk is counted as it streams past (`stats/tally.ts`) and this tab draws
 * the count, so its numbers are the graph's own, narrowed as the graph is narrowed. One tab per
 * repository, as with the graph.
 */

import * as vscode from 'vscode';

import { nonce } from './panel.ts';
import type { StatsHostMessage, StatsWebviewMessage } from './protocol.ts';
import { summarize } from './stats/summary.ts';
import type { Walk } from './stats/tally.ts';
import { STATS_MARKUP } from './webview/markup.ts';

export const STATS_VIEW_TYPE = 'weft.stats';

/** What a statistics tab reads, all of it the extension's to answer. */
export interface StatsSource {
  /** The latest walk of the graph open on a repository, or null when no graph is open on it. */
  walk(root: string): Walk | null;
  /** A repository's hand-made author groups, which fold people exactly as the Authors view does. */
  groups(root: string): ReadonlyMap<string, readonly string[]>;
  /** Open the graph on a repository: the tab's answer to having nothing to count. */
  openGraph(root: string): Promise<void>;
}

export class StatsPanel {
  private static readonly open = new Map<string, StatsPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly root: string;
  private readonly source: StatsSource;
  private readonly disposables: vscode.Disposable[] = [];

  /** Whether the charts count merges: off until the page says otherwise. See `summarize`. */
  private includeMerges = false;
  /** Whether they count the commits `weft.statistics.excludeMessages` matched: off until the page says otherwise. */
  private includeExcluded = false;

  /** The tab for a repository: the one already open, brought forward, or a new one. */
  static show(extensionUri: vscode.Uri, root: string, source: StatsSource, column: vscode.ViewColumn): StatsPanel {
    const existing = StatsPanel.open.get(root);

    if (existing !== undefined) {
      existing.panel.reveal();
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      STATS_VIEW_TYPE,
      `Weft Statistics: ${root.split('/').pop() ?? root}`,
      column,
      {
        enableScripts: true,
        /*
         * Off, unlike the graph's. A graph brought back from being hidden would walk the whole history
         * again; this tab comes back from one message of a few kilobytes, so keeping its page alive
         * while nobody can see it would be memory spent to save nothing.
         */
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');

    const stats = new StatsPanel(panel, extensionUri, root, source);
    StatsPanel.open.set(root, stats);
    return stats;
  }

  /**
   * What a repository's tab shows has changed - a walk started, finished or failed, the graph closed, a
   * group was made - so send it what there is now. Nothing happens when no tab is open on it.
   */
  static update(root: string): void {
    StatsPanel.open.get(root)?.send();
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, root: string, source: StatsSource) {
    this.panel = panel;
    this.root = root;
    this.source = source;

    panel.webview.html = html(panel.webview, extensionUri);
    panel.webview.onDidReceiveMessage(
      (message: StatsWebviewMessage) => this.onMessage(message),
      null,
      this.disposables,
    );
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private onMessage(message: StatsWebviewMessage): void {
    switch (message.type) {
      // A new page - opened, or shown again, which builds it afresh - that knows nothing yet.
      case 'ready':
        this.includeMerges = message.includeMerges;
        this.includeExcluded = message.includeExcluded;
        this.post({ type: 'init', repoName: this.root.split('/').pop() ?? this.root });
        this.send();
        break;

      // The same walk counted the other way: a new summary, and nothing walked.
      case 'includeMerges':
        this.includeMerges = message.on;
        this.send();
        break;

      case 'includeExcluded':
        this.includeExcluded = message.on;
        this.send();
        break;

      case 'openGraph':
        void this.source.openGraph(this.root);
        break;
    }
  }

  /**
   * What the tab should show now, summarized afresh every time: cheaper than keeping a summary current
   * through every walk and every group that could change it.
   */
  private send(): void {
    const walk = this.source.walk(this.root);

    if (walk === null) {
      this.post({ type: 'noGraph' });
    } else if (walk.state === 'walking') {
      this.post({ type: 'walking' });
    } else if (walk.state === 'failed') {
      this.post({ type: 'failed', message: walk.message });
    } else {
      this.post({
        type: 'summary',
        summary: summarize(walk.tally, this.source.groups(this.root), walk.facts, {
          merges: this.includeMerges,
          excluded: this.includeExcluded,
        }),
      });
    }
  }

  private post(message: StatsHostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    StatsPanel.open.delete(this.root);

    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** The page: the graph's content security policy, with a script and a stylesheet from `dist` and nothing else. */
function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'stats.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'style.css'));
  const n = nonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${n}'; connect-src 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style.toString()}" rel="stylesheet">
<title>Weft Statistics</title>
</head>
<body class="weft-stats">
${STATS_MARKUP}
<script nonce="${n}" src="${script.toString()}"></script>
</body>
</html>`;
}
