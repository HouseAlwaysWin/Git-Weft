/**
 * What the canvas draws: lanes, merge arcs, dots, and the working tree hanging off HEAD.
 *
 * Apart from the view for the reason `sort.ts` and `lanes.ts` are: it is geometry, and geometry can
 * be checked without a browser. The surface it draws onto is a parameter rather than a canvas it
 * fetches for itself, so a test can hand it a recorder and read back every call it made - which is
 * a stricter question than "do the pixels look right", and one that can be asked from Node.
 *
 * It owns what the layout streams - the lanes, the arcs, the dots, each row's width - because those
 * arrive together, are thrown away together, and nothing else reads them. It does not own the
 * canvas element, its size, or when a frame happens: those are the view's, and they are handed over
 * per frame in a `Frame`.
 */

import type { GraphDelta } from '../graph/layout.ts';
import type { GraphDot, GraphLink } from '../graph/model.ts';
import { DotKind } from '../graph/model.ts';
import { LaneStore } from '../graph/lanes.ts';

/** How many colours the lanes cycle through; the palette is the view's to read from the theme. */
export const LANE_COLORS = 10;

/** Half the width of a commit dot. */
export const DOT_RADIUS = 3.5;

/**
 * Everything a frame needs that the canvas cannot ask for itself.
 *
 * Read once by the view, before it writes anything - see `measureFrame` there - because asking the
 * DOM for a size after touching it costs a whole layout.
 */
export interface Frame {
  readonly scrollTop: number;
  readonly height: number;
  /** The pixels the lanes have been given, which is not always what they asked for. */
  readonly width: number;
  /** What to multiply a lane's x by to fit that width. 1 when they have all the room they need. */
  readonly scale: number;
  readonly rowHeight: number;
  readonly devicePixelRatio: number;
  /** How many display rows sit above the history: one for the working tree, or none. */
  readonly shift: number;
  /** The panel's own background, for the dots that are drawn hollow. */
  readonly background: string;
  readonly palette: readonly string[];
}

/**
 * The part of a 2D context this uses.
 *
 * Named rather than taking the whole interface so that a test can implement it - the real one has
 * two hundred members and a stub of it would be a day's work to say nothing.
 */
export type Surface = Pick<
  CanvasRenderingContext2D,
  | 'setTransform'
  | 'clearRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'quadraticCurveTo'
  | 'arc'
  | 'stroke'
  | 'fill'
  | 'setLineDash'
  | 'strokeStyle'
  | 'fillStyle'
  | 'lineWidth'
  | 'lineJoin'
  | 'lineCap'
>;

export class GraphPainter {
  private readonly lanes = new LaneStore();

  /**
   * The curved joins from a merge commit into a lane that already existed.
   *
   * The other half of a merge. When a merge's extra parent has no lane yet the layout opens one and
   * that arrives as an ordinary polyline; when it already has one there is nothing to open and the
   * join is this instead. Drawing only the first kind loses every merge into a branch that was
   * already on screen, which on a history that merges often is most of them.
   *
   * In row order, because that is the order the layout produces them in - which is what lets a
   * frame find the visible ones without walking the rest.
   */
  private links: GraphLink[] = [];

  private dots: GraphDot[] = [];

  /** What each row's lanes need at their natural spacing, indexed by commit row. */
  private widths: number[] = [];

  private head: GraphDot | null = null;

  /** The HEAD commit's dot, which is where the working tree hangs from. */
  get headDot(): GraphDot | null {
    return this.head;
  }

  /** Per-row widths, for the view to decide how much room to give the lanes. */
  get rowWidths(): readonly number[] {
    return this.widths;
  }

  /** Take a page's worth of geometry. */
  add(delta: GraphDelta): void {
    this.widths.push(...delta.widths);
    this.links.push(...delta.links);
    this.dots.push(...delta.dots);

    for (const dot of delta.dots) {
      if (dot.kind === DotKind.Head) {
        this.head = dot;
      }
    }

    this.lanes.add(delta.paths);
  }

  clear(): void {
    this.lanes.clear();
    this.links = [];
    this.dots = [];
    this.widths = [];
    this.head = null;
  }

  draw(ctx: Surface, frame: Frame): void {
    const { scrollTop, height, rowHeight, shift, palette } = frame;

    // Applied to coordinates rather than to the transform: scaling the whole context would squash
    // the dots into ellipses and thin the strokes, and neither of those is what "narrower" means.
    const x = (px: number): number => px * frame.scale;
    const y = (row: number): number => (row + shift) * rowHeight - scrollTop;

    const dpr = frame.devicePixelRatio;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, frame.width, height);

    // Lane coordinates are in commit rows; the working-tree row sits above all of them, so every
    // line and dot moves down by however many rows are not part of the history.
    const topRow = scrollTop / rowHeight - shift;
    const bottomRow = (scrollTop + height) / rowHeight - shift;

    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const lane of this.lanes.visible(topRow, bottomRow)) {
      // Interleaved x, y - see `LaneStore`. Two entries a point, and a tab holds a lot of points.
      const pts = lane.points;

      ctx.strokeStyle = palette[lane.color % LANE_COLORS] ?? '#888';
      ctx.beginPath();
      ctx.moveTo(x(pts[0] as number), y(pts[1] as number));

      for (let i = 2; i < pts.length; i += 2) {
        ctx.lineTo(x(pts[i] as number), y(pts[i + 1] as number));
      }

      ctx.stroke();
    }

    /*
     * The arcs, between the lanes and the dots.
     *
     * Over the lanes because an arc joins two of them and has to be seen to; under the dots because
     * a merge dot is what the arc leaves from, and a line across it would read as passing through.
     */
    for (let i = this.firstLink(topRow - 1); i < this.links.length; i++) {
      const link = this.links[i] as GraphLink;

      // Sorted by where they start, so the first one below the fold ends the loop.
      if (link.start.y > bottomRow + 1) {
        break;
      }

      ctx.strokeStyle = palette[link.color % LANE_COLORS] ?? '#888';
      ctx.beginPath();
      ctx.moveTo(x(link.start.x), y(link.start.y));
      ctx.quadraticCurveTo(x(link.control.x), y(link.control.y), x(link.end.x), y(link.end.y));
      ctx.stroke();
    }

    const firstDot = Math.max(0, Math.floor(topRow) - 1);
    const lastDot = Math.min(this.dots.length, Math.ceil(bottomRow) + 1);

    for (let i = firstDot; i < lastDot; i++) {
      const dot = this.dots[i];

      if (dot === undefined) {
        continue;
      }

      const color = palette[dot.color % LANE_COLORS] ?? '#888';
      const cy = y(dot.center.y);

      ctx.beginPath();
      // The centre moves; the radius does not. Lanes sit closer together, dots stay round.
      ctx.arc(
        x(dot.center.x),
        cy,
        dot.kind === DotKind.Head ? DOT_RADIUS + 1.5 : DOT_RADIUS,
        0,
        Math.PI * 2,
      );

      if (dot.kind === DotKind.Merge) {
        // A merge is drawn hollow so it reads differently at a glance without needing a legend.
        ctx.fillStyle = frame.background;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fill();
      }

      if (dot.kind === DotKind.Head) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x(dot.center.x), cy, DOT_RADIUS + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1.5;
      }
    }

    this.drawWorkingTree(ctx, frame, x, y);
  }

  /**
   * The working tree, hanging off HEAD by a dashed line.
   *
   * Only when there is a row for it - `shift` is how many rows sit above the history, and that is
   * the one of them.
   */
  private drawWorkingTree(
    ctx: Surface,
    frame: Frame,
    x: (px: number) => number,
    y: (row: number) => number,
  ): void {
    const head = this.head;

    if (frame.shift === 0 || head === null) {
      return;
    }

    const color = frame.palette[head.color % LANE_COLORS] ?? '#888';
    const top = y(-0.5);
    // Through the same squeeze as everything else on the canvas. Left raw, this hung the working
    // tree off a column no lane was in: a dot and a dashed line beside the graph rather than on it.
    const at = x(head.center.x);

    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(at, top);
    ctx.lineTo(at, y(head.center.y));
    ctx.stroke();

    // Hollow, like a merge dot: the shape says "this is not a commit" before any of the text does.
    ctx.beginPath();
    ctx.arc(at, top, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = frame.background;
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /**
   * The first arc that could be on screen, by binary search.
   *
   * A linear scan from the top is fine until a history has forty thousand merges in it, and then it
   * is forty thousand comparisons per frame to find the twenty that are visible. The layout emits
   * them in row order, so the search is available for free.
   */
  private firstLink(row: number): number {
    let low = 0;
    let high = this.links.length;

    while (low < high) {
      const mid = (low + high) >> 1;

      if ((this.links[mid] as GraphLink).start.y < row) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low;
  }
}
