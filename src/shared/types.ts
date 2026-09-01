// Core geometric primitives
export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 2D affine transform matrix [a, b, c, d, e, f]
// | a  c  e |
// | b  d  f |
// | 0  0  1 |
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

// Fill types
export type SolidFill = {
  type: 'solid';
  color: string; // hex
  opacity: number; // 0–1
};

export type GradientStop = { color: string; opacity: number; offset: number };

export type LinearGradientFill = {
  type: 'linear-gradient';
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  stops: GradientStop[];
  opacity: number;
};

export type RadialGradientFill = {
  type: 'radial-gradient';
  centerX: number;
  centerY: number;
  radius: number;
  stops: GradientStop[];
  opacity: number;
};

// An image used as paint. `imageId` keys into DesignFile.images, the same store the
// image SHAPE type uses, so a photo can be dropped on any shape without changing its type.
export type ImageFill = {
  type: 'image';
  imageId: string;
  // How the image is fitted to the box — the four modes Figma offers.
  scaleMode: 'fill' | 'fit' | 'stretch' | 'tile';
  // 'tile' only: the tile's size relative to the image's natural size.
  tileScale?: number;
  opacity: number;
};

export type Fill = SolidFill | LinearGradientFill | RadialGradientFill | ImageFill;

// Stroke
export type StrokeAlign = 'inner' | 'outer' | 'center';
export type StrokeCap = 'none' | 'round' | 'square' | 'arrow';
export type StrokeStyle = 'solid' | 'dashed' | 'dotted';

export interface Stroke {
  color: string;
  opacity: number;
  width: number;
  align: StrokeAlign;
  cap: StrokeCap;
  style: StrokeStyle;
}

// Shadow
export interface Shadow {
  type: 'drop' | 'inner';
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: string;
  opacity: number;
  hidden: boolean;
}

// Blur
export interface BlurEffect {
  type: 'layer-blur' | 'background-blur';
  value: number;
  hidden: boolean;
}

// Typography
export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export type TextDecoration = 'none' | 'underline' | 'line-through';
export type TextTransform = 'none' | 'uppercase' | 'lowercase' | 'capitalize';

export interface TextStyle {
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: number; // multiplier, e.g. 1.2
  letterSpacing: number; // px
  textDecoration: TextDecoration;
  textTransform: TextTransform;
  color: string;
  opacity: number;
}

export interface TextParagraph {
  align: TextAlign;
  spans: { text: string; style?: Partial<TextStyle> }[];
}

// SVG anchor-point editing
export interface SvgAnchorPoint {
  command: 'M' | 'L' | 'C' | 'Q' | 'Z';
  x: number;      // viewBox coords
  y: number;
  cp1x?: number;
  cp1y?: number;
  cp2x?: number;
  cp2y?: number;
}

export interface SvgPathEdit {
  originalD: string;          // original d attr (for reset)
  currentD: string;           // current (possibly edited) d
  points: SvgAnchorPoint[];   // parsed editable points
}

export interface SvgPointRef {
  pathIndex: number;   // which SvgPathEdit
  pointIndex: number;  // which SvgAnchorPoint
}

// Path segment
export type PathVerb = 'M' | 'L' | 'C' | 'Q' | 'Z';
export interface PathSegment {
  verb: PathVerb;
  // For M/L: [x,y]; C: [cx1,cy1,cx2,cy2,x,y]; Q: [cx,cy,x,y]; Z: []
  coords: number[];
}

export interface AnchorPoint {
  index: number;      // position in the points array
  command: PathVerb;
  x: number;         // anchor (endpoint) x in shape-local space
  y: number;
  cp1x?: number;     // incoming control point (C: first pair; Q: the single cp)
  cp1y?: number;
  cp2x?: number;     // outgoing control point (C: second pair)
  cp2y?: number;
}

// Shape types
export type ShapeType = 'rect' | 'circle' | 'path' | 'text' | 'image' | 'svg' | 'vector' | 'frame' | 'group' | 'bool';
export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay'
  | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light' | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

// Component & asset library types
export interface ComponentEntry {
  name: string;
  pageId: string;
  shapeId: string;   // ID of the master shape
  // Set when this component is one variant inside a component set.
  setId?: string;
  // Component properties exposed on every instance of this component.
  props?: ComponentPropDef[];
}

// A property an instance can set without detaching. `boolean` shows/hides the layers
// bound to it; `text` replaces their text content.
export interface ComponentPropDef {
  id: string;
  name: string;
  type: 'boolean' | 'text';
  defaultValue: string | boolean;
}

// Which component property drives which aspect of a layer inside the master.
export interface PropBindings {
  visible?: string;    // ComponentPropDef id (boolean)
  characters?: string; // ComponentPropDef id (text)
}

// A set of components that differ only by their variant property values — Figma's
// component set. `properties` fixes the property order and the values each one offers;
// `variants` says which combination each component implements.
export interface ComponentSetEntry {
  id: string;
  name: string;
  properties: Record<string, string[]>;
  variants: Record<string, Record<string, string>>;
  defaultComponentId: string;
}

export interface ColorEntry {
  id: string;
  name: string;
  color: string;     // hex
  opacity: number;
}

export interface TypographyEntry {
  id: string;
  name: string;
  style: Partial<TextStyle>;
}

// A named effect stack (Figma's effect styles) — shadows plus the single blur a shape
// can carry, saved together so a card elevation can be reused and updated in one place.
export interface EffectEntry {
  id: string;
  name: string;
  shadows: Shadow[];
  blur: BlurEffect | null;
}

// A named set of layout grids (Figma's grid styles), applied to a frame as a unit.
export interface GridStyleEntry {
  id: string;
  name: string;
  grids: LayoutGrid[];
}

// ── W3C Design Tokens ─────────────────────────────────────────────────────────
// Follows the W3C Design Tokens Community Group format.
// $type / $value, with aliases written as "{group.token}".

export type TokenType = 'color' | 'dimension' | 'number' | 'fontFamily' | 'fontWeight' | 'spacing' | 'borderRadius' | 'opacity';

export interface DesignToken {
  id: string;
  name: string;            // dotted path, e.g. "color.primary" or "spacing.md"
  $type: TokenType;
  $value: string | number; // literal OR alias "{other.token}"
  $description?: string;
}

// A theme set is a named override map: tokenName → value.
// The "default" set holds base values; other sets override for light/dark/etc.
export interface ThemeSet {
  id: string;
  name: string;
  // Partial overrides: only tokens that differ from default
  values: Record<string, string | number>;
}

// A property on a shape can be BOUND to a token. We store the binding
// separately so the literal value stays in sync via the resolver.
// Key format: "fills.0.color", "strokes.0.width", "x", "textStyle.fontSize", etc.
export type TokenBindings = Record<string, string>; // bindingKey → tokenName

// ── Prototyping interactions ──────────────────────────────────────────────────

// Figma's trigger list. 'hover' and 'press' are the two that REVERT when the pointer
// leaves or the button is released; the mouse-* ones fire once.
export type InteractionTrigger =
  | 'click' | 'drag' | 'hover' | 'press' | 'key'
  | 'mouse-enter' | 'mouse-leave' | 'mouse-down' | 'mouse-up'
  | 'after-delay';

export type InteractionAction =
  | 'navigate' | 'back' | 'overlay' | 'swap-overlay' | 'close-overlay'
  | 'url' | 'scroll-to' | 'none';

export type Transition =
  | 'none' | 'dissolve' | 'smart'
  | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down'
  | 'push-left' | 'push-right' | 'push-up' | 'push-down'
  | 'move-in-left' | 'move-in-right' | 'move-in-up' | 'move-in-down'
  | 'move-out-left' | 'move-out-right' | 'move-out-up' | 'move-out-down';

export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'ease-out-back';

// Where an overlay sits over the screen beneath it.
export type OverlayPosition =
  | 'center' | 'top-left' | 'top-center' | 'top-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'manual';

export interface OverlaySettings {
  position: OverlayPosition;
  // 'manual' only — offset from the screen's top-left, in frame coordinates.
  x?: number;
  y?: number;
  // Dim the screen behind the overlay.
  background: 'none' | 'dim';
  closeOnClickOutside: boolean;
}

export interface Interaction {
  id: string;
  trigger: InteractionTrigger;
  action: InteractionAction;
  targetFrameId?: string; // navigate / overlay / swap-overlay
  url?: string;           // url action
  transition: Transition;
  // Animation timing. Defaults: 300ms, ease-out.
  duration?: number;      // ms
  easing?: Easing;
  // 'after-delay' trigger: how long after the screen appears, in ms.
  delay?: number;
  // 'key' trigger: the KeyboardEvent.key to match, e.g. 'Enter' or 'ArrowRight'.
  keyCode?: string;
  // overlay / swap-overlay
  overlay?: OverlaySettings;
  // 'scroll-to': the layer to bring into view on the current screen.
  scrollTargetId?: string;
}

export function makeDefaultOverlaySettings(): OverlaySettings {
  return { position: 'center', background: 'dim', closeOnClickOutside: true };
}

// ── Layout grids ──────────────────────────────────────────────────────────────
// Figma's frame overlays: a uniform square grid, or column/row tracks. Purely visual —
// they guide placement (and snapping) and never affect layout or exports.

export type LayoutGridType = 'columns' | 'rows' | 'grid';
// How the track block sits in the frame. 'stretch' divides the frame minus margins;
// the others lay fixed-size tracks from the start edge, the end edge, or the centre.
export type LayoutGridAlign = 'min' | 'max' | 'center' | 'stretch';

export interface LayoutGrid {
  id: string;
  type: LayoutGridType;
  visible: boolean;
  color: string;    // hex
  opacity: number;  // 0–1
  size: number;         // 'grid': cell size in px
  count: number;        // columns/rows: number of tracks
  gutter: number;       // gap between tracks
  offset: number;       // distance from the start ('min') or end ('max') edge
  margin: number;       // 'stretch': inset on both ends
  sectionSize: number;  // fixed track size when alignment isn't 'stretch'
  alignment: LayoutGridAlign;
}

export function makeDefaultLayoutGrid(type: LayoutGridType, id: string): LayoutGrid {
  return {
    id, type, visible: true,
    color: type === 'grid' ? '#000000' : '#FF0000',
    opacity: 0.1,
    size: 8, count: 12, gutter: 20, offset: 0, margin: 0,
    sectionSize: 64, alignment: 'stretch',
  };
}

// ── Resize constraints ────────────────────────────────────────────────────────
// The behaviours live in shared/constraints.ts; the stored setting lives here so Shape
// stays the single source of truth for document data.

export type ConstraintMode = 'min' | 'max' | 'stretch' | 'center' | 'scale';

export interface Constraints {
  horizontal: ConstraintMode;
  vertical: ConstraintMode;
}

// ── Per-layer export presets ──────────────────────────────────────────────────

export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'svg';

export interface ExportSetting {
  id: string;
  format: ExportFormat;
  scale: number;   // raster only; SVG ignores it
  suffix: string;  // appended to the layer name, e.g. "@2x" or "-dark"
}

// ── Padding (shared by Auto Layout) ───────────────────────────────────────────

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// ── Figma-style Auto Layout settings ───────────────────────────────────────────
// Stored on a Shape that acts as an auto-layout container. The pure engine in
// `autoLayout.ts` consumes the same fields via an adapter.

// Primary-axis distribution. Names mirror CSS / the engineering spec.
export type AutoLayoutJustify =
  | 'start' | 'center' | 'end'
  | 'space-between' | 'space-around' | 'space-evenly';
// Cross-axis alignment of each child within the content box.
export type AutoLayoutAlign = 'start' | 'center' | 'end';

export interface AutoLayoutSettings {
  direction: 'horizontal' | 'vertical' | 'wrap' | 'grid';
  reversed?: boolean;
  // primary-axis gap between children. undefined = Auto (Figma default: preserves
  // even distribution without a manually-set fixed value; treated as 0 by the engine).
  spacing?: number;
  padding: Padding;           // inset on each side
  justifyContent: AutoLayoutJustify;   // primary axis
  alignItems: AutoLayoutAlign;         // cross axis
  // Wrap only: how the rows are distributed on the cross axis when the container is
  // taller than its content. Defaults to 'start'.
  alignContent?: 'start' | 'center' | 'end' | 'space-between';
  // When true, each child's stroke extent counts toward spacing + hug bounds (Figma's
  // "Stroke: Included in layout"). Default false (strokes overlap, don't push siblings).
  strokeInLayout?: boolean;
  // Grid only: number of equal-width columns. Children flow row-major; rows auto-size to
  // their tallest child. `spacing` is used for both row and column gaps. Default 2.
  columns?: number;
}

export interface VectorChildNode {
  id: string;
  name: string;
  type: 'vector-rect' | 'vector-circle' | 'vector-ellipse' | 'vector-path'
      | 'vector-poly' | 'vector-line' | 'vector-group' | 'vector-raw';
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  opacity: number;
  transform?: string;
  // rect
  x?: number; y?: number; width?: number; height?: number; rx?: number;
  // circle
  cx?: number; cy?: number; r?: number;
  // ellipse (ry for y-radius, rx reused for x-radius)
  ry?: number;
  // path
  d?: string;
  // poly
  points?: string; closed?: boolean;
  // line
  x1?: number; y1?: number; x2?: number; y2?: number;
  // group children
  children?: VectorChildNode[];
  // raw fallback
  outerHTML?: string;
}

export interface Shape {
  id: string;
  type: ShapeType;
  name: string;

  // Position & size in local coordinates
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // degrees

  // Transform applied on top of x/y/rotation (for skew, non-uniform scale)
  transform: Matrix;

  // Hierarchy
  parentId: string | null; // null = root frame owns it
  frameId: string;         // nearest ancestor frame
  childIds: string[];      // ordered child ids (frames/groups)

  // Visibility & interaction
  hidden: boolean;
  locked: boolean;
  blocked: boolean;        // cannot be selected on canvas (clip-content ancestor)
  opacity: number;
  blendMode: BlendMode;

  // Styling
  fills: Fill[];
  strokes: Stroke[];
  shadows: Shadow[];
  blur: BlurEffect | null;

  // Clip content (frames only — clips children to frame bounds)
  clipContent: boolean;

  // Layout grid overlays (frames only). View-only: never exported, never affects layout.
  layoutGrids?: LayoutGrid[];

  // Figma-style Auto Layout. When `autoLayout` is set on a shape, the autoLayout
  // engine reflows its children on every change. Sizing fields apply to ANY shape
  // (they say how the shape sizes within its parent if the parent is auto-layout).
  autoLayout?: AutoLayoutSettings | null;
  widthMode?: 'hug' | 'fill' | 'fixed';
  heightMode?: 'hug' | 'fill' | 'fixed';
  // Declared (intrinsic) size on an axis the layout engine resolves for the shape
  // ('fill'). width/height always hold the RESOLVED size — that's what renders and
  // hit-tests — so without this the stretched size would overwrite what the user
  // typed: switching back to Fixed would keep the stretched number, and a hugging
  // ancestor would measure the stretched child and ratchet itself wider every reflow.
  // Captured when the engine first stretches an axis, restored (and cleared) when the
  // axis leaves 'fill' or the user sets the size explicitly.
  baseWidth?: number;
  baseHeight?: number;
  // How this shape responds when its parent is resized (Figma constraints). Unset =
  // pinned to the left/top edges, Figma's default. Ignored while the auto-layout engine
  // owns the shape's box; absolute-positioned children still follow it.
  constraints?: Constraints;
  // Excludes this shape from its auto-layout parent's flow (Figma "Absolute position").
  // The shape keeps its own x/y/size and is not counted in the parent's hug measurement.
  layoutPositioning?: 'auto' | 'absolute';
  // Min/Max size clamps (Figma). Applied to hug/fill/fixed resolution. undefined = unbounded.
  minWidth?: number; maxWidth?: number;
  minHeight?: number; maxHeight?: number;

  // Corner radius per corner (frames and rects). Rendered via roundRect.
  cornerRadii?: { tl: number; tr: number; br: number; bl: number };
  // Figma-style corner smoothing (0–100). 0 = CSS border-radius, 100 = fully smooth.
  cornerSmoothing?: number;

  // Component system
  componentId?: string;              // set on master shapes
  masterId?: string;                 // set on instances — points to a componentId
  // Set on every shape inside an instance (root included): the id of the shape it
  // mirrors in the master's subtree. Master edits find their counterparts through this,
  // so a component with children stays linked all the way down.
  masterShapeId?: string;
  overrides?: Record<string, unknown>; // locally-touched properties on instances
  // Master-side: which component properties drive this layer.
  propBindings?: PropBindings;
  // Instance-side (root only): the values chosen for the component's properties.
  componentProps?: Record<string, string | boolean>;

  // Token bindings: property path → token name
  tokenBindings?: TokenBindings;

  // Prototyping interactions (any shape can be a hotspot)
  interactions?: Interaction[];

  // Prototype scrolling. On a FRAME: which axes its content scrolls on. On a child of a
  // scrolling frame: whether it moves with the content or stays put (Figma's
  // "Scroll behavior → Position").
  scrollBehavior?: 'none' | 'vertical' | 'horizontal' | 'both';
  scrollPosition?: 'scrolls' | 'fixed';

  // Saved export presets for this layer (Figma's per-layer Export list). Each entry
  // produces one file; `suffix` is appended to the layer name.
  exportSettings?: ExportSetting[];

  // Shape-specific payloads
  content?: PathSegment[];     // type='path' or 'bool'
  paragraphs?: TextParagraph[]; // type='text'
  textStyle?: TextStyle;        // type='text' base style
  textAutoWidth?: boolean;      // type='text': true=grows horizontally (click-created), false=fixed-width (drag-created)
  // type='text': false pins the box height, so the text clips instead of re-fitting.
  // Undefined behaves as true (auto height), which is Figma's default for a text box.
  textAutoHeight?: boolean;
  imageId?: string;             // type='image'
  svgContent?: string;          // type='svg'/'vector': raw SVG markup
  svgInnerHTML?: string;        // type='vector': innerHTML of <svg> (no outer tag) for inline DOM rendering
  svgOriginalWidth?: number;   // viewBox width at import time
  svgOriginalHeight?: number;  // viewBox height at import time
  vectorChildren?: VectorChildNode[]; // type='vector': parsed editable SVG tree
  isSVGImport?: boolean;             // type='frame': marks a frame created by SVG import (children are individual svg elements)
  // Mirrored content (Figma ⇧H / ⇧V). Positions of a container's descendants are
  // mirrored by the flip command itself; this flag mirrors the shape's OWN drawing.
  flipH?: boolean;
  flipV?: boolean;
  // Text: vertical placement of the text block inside the shape's box.
  textVerticalAlign?: 'top' | 'middle' | 'bottom';
  aspectRatioLocked?: boolean;  // lock W:H ratio in panel + drag
  lockedAspectRatio?: number;   // width/height at lock time

  // Boolop type
  boolType?: 'union' | 'difference' | 'intersection' | 'exclusion'; // type='bool'

  // Figma "Use as mask": this layer clips every later sibling in its parent to its own
  // alpha. Masking is non-destructive — the masked layers keep their own geometry.
  isMask?: boolean;

  // Computed bounding rect (denormalized for hit-testing — updated after transform)
  selrect: Rect;
}

export function makeDefaultShape(overrides: Partial<Shape> & Pick<Shape, 'id' | 'type' | 'name' | 'frameId'>): Shape {
  const { id, type, name, frameId, ...rest } = overrides;
  return {
    id,
    type,
    name,
    frameId,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    transform: IDENTITY_MATRIX,
    parentId: null,
    childIds: [],
    hidden: false,
    locked: false,
    blocked: false,
    opacity: 1,
    blendMode: 'normal',
    fills: [{ type: 'solid', color: '#B1B2FF', opacity: 1 }],
    strokes: [],
    shadows: [],
    blur: null,
    clipContent: false,
    selrect: { x: 0, y: 0, width: 100, height: 100 },
    ...rest,
  };
}

export interface Guide {
  id: string;
  type: 'horizontal' | 'vertical';
  position: number; // canvas coordinate — zoom/pan independent
}

// Page
export interface Page {
  id: string;
  name: string;
  objects: Record<string, Shape>; // flat shape map
  childIds: string[];             // root-level shape order
  background: string;             // hex color
}

export function makeDefaultPage(id: string, name: string): Page {
  return {
    id,
    name,
    objects: {},
    childIds: [],
    background: '#F0F0F4',
  };
}

// File (the document)
export interface DesignFile {
  id: string;
  name: string;
  version: number;
  pages: Page[];
  activePageId: string;
  // Assets
  images: Record<string, string>;              // id → base64 data-url
  components: Record<string, ComponentEntry>;  // componentId → entry
  componentSets?: Record<string, ComponentSetEntry>; // setId → variant set
  colors: ColorEntry[];
  typographies: TypographyEntry[];
  effects?: EffectEntry[];
  gridStyles?: GridStyleEntry[];
  // Design tokens
  tokens: DesignToken[];
  themes: ThemeSet[];
  activeThemeId: string;                       // 'default' or a ThemeSet id
  // Guides per page (canvas coords, zoom/pan independent)
  guidesPerPage?: Record<string, Guide[]>;
  // Prototype entry point (a top-level frame id)
  prototypeStartFrameId?: string;
}

export function makeDefaultFile(): DesignFile {
  const pageId = 'page-1';
  return {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `file-${Date.now()}`,
    name: 'Untitled',
    version: 1,
    pages: [makeDefaultPage(pageId, 'Page 1')],
    activePageId: pageId,
    images: {},
    components: {},
    colors: [],
    typographies: [],
    tokens: [],
    themes: [],
    activeThemeId: 'default',
  };
}

// ──────────────────────────────────────────────
// IPC contract
// ──────────────────────────────────────────────

export type IPCChannel =
  | 'file:open'
  | 'file:save'
  | 'file:new'
  | 'doc:applyChanges'
  | 'doc:undo'
  | 'doc:redo'
  | 'doc:getState';

export interface IPCRequest<T = unknown> {
  channel: IPCChannel;
  payload?: T;
}

export interface IPCResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// Change operations
export type ChangeOp =
  | { op: 'set'; id: string; attr: string; val: unknown }
  | { op: 'setImage'; id: string; dataUrl: string | null }
  | { op: 'setVectorChild'; id: string; childId: string; attr: string; val: unknown }
  | { op: 'add'; shape: Shape }
  | { op: 'del'; id: string }
  | { op: 'move'; id: string; parentId: string | null; index: number };

export interface ChangeSet {
  pageId: string;
  ops: ChangeOp[];
}
