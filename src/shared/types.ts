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

export type Fill = SolidFill | LinearGradientFill | RadialGradientFill;

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

export type InteractionTrigger = 'click' | 'hover';
export type InteractionAction = 'navigate' | 'back' | 'overlay' | 'close-overlay' | 'url';
export type Transition = 'none' | 'dissolve' | 'slide-left' | 'slide-right' | 'slide-up' | 'smart';

export interface Interaction {
  id: string;
  trigger: InteractionTrigger;
  action: InteractionAction;
  targetFrameId?: string; // navigate / overlay
  url?: string;           // url action
  transition: Transition;
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

  // Figma-style Auto Layout. When `autoLayout` is set on a shape, the autoLayout
  // engine reflows its children on every change. Sizing fields apply to ANY shape
  // (they say how the shape sizes within its parent if the parent is auto-layout).
  autoLayout?: AutoLayoutSettings | null;
  widthMode?: 'hug' | 'fill' | 'fixed';
  heightMode?: 'hug' | 'fill' | 'fixed';
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
  overrides?: Record<string, unknown>; // locally-touched properties on instances

  // Token bindings: property path → token name
  tokenBindings?: TokenBindings;

  // Prototyping interactions (any shape can be a hotspot)
  interactions?: Interaction[];

  // Shape-specific payloads
  content?: PathSegment[];     // type='path' or 'bool'
  paragraphs?: TextParagraph[]; // type='text'
  textStyle?: TextStyle;        // type='text' base style
  textAutoWidth?: boolean;      // type='text': true=grows horizontally (click-created), false=fixed-width (drag-created)
  imageId?: string;             // type='image'
  svgContent?: string;          // type='svg'/'vector': raw SVG markup
  svgInnerHTML?: string;        // type='vector': innerHTML of <svg> (no outer tag) for inline DOM rendering
  svgOriginalWidth?: number;   // viewBox width at import time
  svgOriginalHeight?: number;  // viewBox height at import time
  vectorChildren?: VectorChildNode[]; // type='vector': parsed editable SVG tree
  isSVGImport?: boolean;             // type='frame': marks a frame created by SVG import (children are individual svg elements)
  aspectRatioLocked?: boolean;  // lock W:H ratio in panel + drag
  lockedAspectRatio?: number;   // width/height at lock time

  // Boolop type
  boolType?: 'union' | 'difference' | 'intersection' | 'exclusion'; // type='bool'

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
  colors: ColorEntry[];
  typographies: TypographyEntry[];
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
