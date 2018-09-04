/**
 * Copyright 2013 Google, Inc.
 * Copyright 2015 Trim-marks Inc.
 *
 * Vivliostyle.js is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Vivliostyle.js is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Vivliostyle.js.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @fileoverview Fills a column with styled content. This file does not
 * communicate with the styling system directly. Instead it goes through the
 * layout interface that gives it one view tree node at a time.
 */
import * as asserts from '../vivliostyle/asserts';
import * as logging from '../vivliostyle/logging';
import {ResolveLayoutProcessorHook} from '../vivliostyle/plugin';
import {PostLayoutBlockHook} from '../vivliostyle/plugin';
import {ResolveTextNodeBreakerHook} from '../vivliostyle/plugin';
import {plugin} from '../vivliostyle/plugin';
import {ElementsOffset} from '../vivliostyle/repetitiveelements';
import * as repetitiveelements from '../vivliostyle/repetitiveelements';
import {processAfterIfContinues, processAfterIfContinuesOfAncestors} from '../vivliostyle/selectors';
import {Size, getSize} from '../vivliostyle/sizing';
import {resolveNewIndex} from '../vivliostyle/diff';
import {TableFormattingContext} from '../vivliostyle/table';
import {isBlock} from '../vivliostyle/display';

import * as base from './base';
import {ident, Val} from './css';
import * as geom from './geom';
import * as task from './task';

import * as breaks from '../vivliostyle/break';
import * as vtree from './vtree';
import * as layoututil from '../vivliostyle/layoututil';
import * as pagefloat from '../vivliostyle/pagefloat';

declare var DEBUG: boolean; 

export const mediaTags = {
  'img': true,
  'svg': true,
  'audio': true,
  'video': true
};

/**
 * Though method used to be used as a workaround for Chrome bug, it seems that
 * the bug has been already fixed:
 *   https://bugs.chromium.org/p/chromium/issues/detail?id=297808
 * We now use this method as a workaround for Firefox bug:
 *   https://bugzilla.mozilla.org/show_bug.cgi?id=1159309
 */
export const fixBoxesForNode =
    (clientLayout: vtree.ClientLayout, boxes: vtree.ClientRect[],
     node: Node): vtree.ClientRect[] => {
      const fullRange = node.ownerDocument.createRange();
      fullRange.setStart(node, 0);
      fullRange.setEnd(node, node.textContent.length);
      const fullBoxes = clientLayout.getRangeClientRects(fullRange);
      const result = [];
      for (const box of boxes) {
        let k;
        for (k = 0; k < fullBoxes.length; k++) {
          const fullBox = fullBoxes[k];
          if (box.top >= fullBox.top && box.bottom <= fullBox.bottom &&
              Math.abs(box.left - fullBox.left) < 1) {
            result.push({
              top: box.top,
              left: fullBox.left,
              bottom: box.bottom,
              right: fullBox.right
            });
            break;
          }
        }
        if (k == fullBoxes.length) {
          logging.logger.warn('Could not fix character box');
          result.push(box);
        }
      }
      return result;
    };

/**
 * Calculate the position of the "after" edge in the block-progression
 * dimension. Return 0 if position was determined successfully and return
 * non-zero if position could not be determined and the node should be
 * considered zero-height.
 */
export const calculateEdge =
    (nodeContext: vtree.NodeContext, clientLayout: vtree.ClientLayout,
     extraOffset: number, vertical: boolean): number => {
      const node = nodeContext.viewNode;
      if (!node) {
        return NaN;
      }
      if (node.nodeType == 1) {
        if (nodeContext.after || !nodeContext.inline) {
          const cbox = clientLayout.getElementClientRect((node as Element));
          if (cbox.right >= cbox.left && cbox.bottom >= cbox.top) {
            if (nodeContext.after) {
              return vertical ? cbox.left : cbox.bottom;
            } else {
              return vertical ? cbox.right : cbox.top;
            }
          }
        }
        return NaN;
      } else {
        let edge = NaN;
        const range = node.ownerDocument.createRange();
        const length = node.textContent.length;
        if (!length) {
          return NaN;
        }
        if (nodeContext.after) {
          extraOffset += length;
        }
        if (extraOffset >= length) {
          extraOffset = length - 1;
        }
        range.setStart(node, extraOffset);
        range.setEnd(node, extraOffset + 1);
        let boxes = clientLayout.getRangeClientRects(range);
        if (vertical && base.checkVerticalBBoxBug(document.body)) {
          boxes = fixBoxesForNode(clientLayout, boxes, node);
        }
        let maxSize = 0;

        // Get first of the widest boxes (works around Chrome results for soft
        // hyphens).
        for (const box of boxes) {
          const boxSize =
              vertical ? box.bottom - box.top : box.right - box.left;
          if (box.right > box.left && box.bottom > box.top &&
              (isNaN(edge) || boxSize > maxSize)) {
            edge = vertical ? box.left : box.bottom;
            maxSize = boxSize;
          }
        }
        return edge;
      }
    };

// NaN or not NaN

/**
 * Processor doing some special layout (e.g. table layout)
 */
export interface LayoutProcessor {
  /**
   * Do actual layout in the column starting from given NodeContext.
   */
  layout(nodeContext: vtree.NodeContext, column: Column, leadingEdge: boolean):
      task.Result<vtree.NodeContext>;

  /**
   * Potential edge breaking position.
   */
  createEdgeBreakPosition(
      position: vtree.NodeContext, breakOnEdge: string|null, overflows: boolean,
      columnBlockSize: number): BreakPosition;

  /**
   * process nodecontext at the start of a non inline element.
   * @return return true if you skip the subsequent nodes
   */
  startNonInlineElementNode(nodeContext: vtree.NodeContext): boolean;

  /**
   * process nodecontext after a non inline element.
   * @return return true if you skip the subsequent nodes
   */
  afterNonInlineElementNode(
      nodeContext: vtree.NodeContext, stopAtOverflow: boolean): boolean;

  /**
   * @return holing true
   */
  finishBreak(
      column: Column, nodeContext: vtree.NodeContext, forceRemoveSelf: boolean,
      endOfColumn: boolean): task.Result<boolean>|null;

  clearOverflownViewNodes(
      column: Column, parentNodeContext: vtree.NodeContext,
      nodeContext: vtree.NodeContext, removeSelf: boolean);
}

/**
 * Resolver finding an appropriate LayoutProcessor given a formatting context
 */
export class LayoutProcessorResolver {
  /**
   * Find LayoutProcessor corresponding to given formatting context.
   */
  find(formattingContext: vtree.FormattingContext): LayoutProcessor {
    const hooks: ResolveLayoutProcessorHook[] =
        plugin.getHooksForName(
            plugin.HOOKS.RESOLVE_LAYOUT_PROCESSOR);
    for (let i = 0; i < hooks.length; i++) {
      const processor = hooks[i](formattingContext);
      if (processor) {
        return processor;
      }
    }
    throw new Error(`No processor found for a formatting context: ${
        formattingContext.getName()}`);
  }
}

/**
 * Represents a constraint on layout
 */
export interface LayoutConstraint {
  /**
   * Returns if this constraint allows the node context to be laid out at the
   * current position.
   */
  allowLayout(nodeContext: vtree.NodeContext): boolean;
}

/**
 * Represents a constraint that allows layout if all the constraints it contains
 * allow layout.
 */
export class AllLayoutConstraint implements LayoutConstraint {
  constructor(public readonly constraints: LayoutConstraint[]) {}

  /**
   * @override
   */
  allowLayout(nodeContext) {
    return this.constraints.every((c) => c.allowLayout(nodeContext));
  }
}

/**
 * Represents constraints on laying out fragments
 */
export interface FragmentLayoutConstraint {
  allowLayout(
      nodeContext: vtree.NodeContext, overflownNodeContext: vtree.NodeContext,
      column: Column): boolean;

  nextCandidate(nodeContext: vtree.NodeContext): boolean;

  postLayout(
      allowed: boolean, positionAfter: vtree.NodeContext,
      initialPosition: vtree.NodeContext, column: Column);

  finishBreak(nodeContext: vtree.NodeContext, column: Column):
      task.Result<boolean>;

  equalsTo(constraint: FragmentLayoutConstraint): boolean;

  getPriorityOfFinishBreak(): number;
}

/**
 * Potential breaking position.
 */
export interface BreakPosition {
  /**
   * @return break position, if found
   */
  findAcceptableBreak(column: Column, penalty: number): vtree.NodeContext;

  /**
   * @return penalty for this break position
   */
  getMinBreakPenalty(): number;

  calculateOffset(column: Column): {current: number, minimum: number};

  breakPositionChosen(column: Column);
}

/**
 * @abstract
 */
export class AbstractBreakPosition implements BreakPosition {
  /**
   * @abstract
   */
  findAcceptableBreak(column, penalty) {}

  /**
   * @abstract
   */
  getMinBreakPenalty() {}

  calculateOffset(column): {current: number, minimum: number} {
    return calculateOffset(
        this.getNodeContext(),
        repetitiveelements.collectElementsOffset(column));
  }

  /**
   * @override
   */
  breakPositionChosen(column) {}

  getNodeContext(): vtree.NodeContext {return null;}
}

export function calculateOffset(
    nodeContext: vtree.NodeContext,
    elementsOffsets: ElementsOffset[]): {current: number, minimum: number} {
  return {
    current: elementsOffsets.reduce(
        (val, repetitiveElement) =>
            val + repetitiveElement.calculateOffset(nodeContext),
        0),
    minimum: elementsOffsets.reduce(
        (val, repetitiveElement) =>
            val + repetitiveElement.calculateMinimumOffset(nodeContext),
        0)
  };
}
type BreakPositionAndNodeContext = {
  breakPosition: BreakPosition,
  nodeContext: vtree.NodeContext
};

export {BreakPositionAndNodeContext};

/**
 * Potential breaking position inside CSS box (between lines).
 * @param checkPoints array of breaking points for
 *    breakable block
 */
export class BoxBreakPosition extends AbstractBreakPosition {
  private alreadyEvaluated: boolean = false;
  breakNodeContext: vtree.NodeContext = null;

  constructor(
      public readonly checkPoints: vtree.NodeContext[],
      public readonly penalty: number) {
    super();
  }

  /**
   * @override
   */
  findAcceptableBreak(column, penalty) {
    if (penalty < this.getMinBreakPenalty()) {
      return null;
    }
    if (!this.alreadyEvaluated) {
      this.breakNodeContext = column.findBoxBreakPosition(this, penalty > 0);
      this.alreadyEvaluated = true;
    }
    return this.breakNodeContext;
  }

  /**
   * @override
   */
  getMinBreakPenalty() {
    return this.penalty;
  }

  /** @override */
  getNodeContext() {
    return this.alreadyEvaluated ?
        this.breakNodeContext :
        this.checkPoints[this.checkPoints.length - 1];
  }
}

/**
 * Potential edge breaking position.
 */
export class EdgeBreakPosition extends AbstractBreakPosition {
  overflowIfRepetitiveElementsDropped: boolean;
  protected isEdgeUpdated: boolean = false;
  private edge: number = 0;
  overflows: any;

  constructor(
      public readonly position: vtree.NodeContext,
      public readonly breakOnEdge: string|null, public overflows: boolean,
      public readonly computedBlockSize: number) {
    super();
    this.overflowIfRepetitiveElementsDropped = overflows;
  }

  /**
   * @override
   */
  findAcceptableBreak(column, penalty) {
    this.updateOverflows(column);
    if (penalty < this.getMinBreakPenalty()) {
      return null;
    }
    return column.findEdgeBreakPosition(this);
  }

  /**
   * @override
   */
  getMinBreakPenalty() {
    if (!this.isEdgeUpdated) {
      throw new Error('EdgeBreakPosition.prototype.updateEdge not called');
    }
    const preferDropping = this.isFirstContentOfRepetitiveElementsOwner() &&
        !this.overflowIfRepetitiveElementsDropped;
    return (breaks.isAvoidBreakValue(this.breakOnEdge) ? 1 : 0) +
        (this.overflows && !preferDropping ? 3 : 0) +
        (this.position.parent ? this.position.parent.breakPenalty : 0);
  }

  private updateEdge(column: Column) {
    const clonedPaddingBorder =
        column.calculateClonedPaddingBorder(this.position);
    this.edge =
        calculateEdge(this.position, column.clientLayout, 0, column.vertical) +
        clonedPaddingBorder;
    this.isEdgeUpdated = true;
  }

  private updateOverflows(column: Column) {
    if (!this.isEdgeUpdated) {
      this.updateEdge(column);
    }
    const edge = this.edge;
    const offsets = this.calculateOffset(column);
    this.overflowIfRepetitiveElementsDropped =
        column.isOverflown(edge + (column.vertical ? -1 : 1) * offsets.minimum);
    this.overflows = this.position.overflow =
        column.isOverflown(edge + (column.vertical ? -1 : 1) * offsets.current);
  }

  /** @override */
  getNodeContext() {
    return this.position;
  }

  private isFirstContentOfRepetitiveElementsOwner(): boolean {
    return repetitiveelements
        .isFirstContentOfRepetitiveElementsOwner(this.getNodeContext());
  }
}

export const validateCheckPoints = (checkPoints: vtree.NodeContext[]) => {
  for (let i = 1; i < checkPoints.length; i++) {
    const cp0 = checkPoints[i - 1];
    const cp1 = checkPoints[i];
    if (cp0 === cp1) {
      logging.logger.warn('validateCheckPoints: duplicate entry');
    } else if (cp0.boxOffset >= cp1.boxOffset) {
      logging.logger.warn('validateCheckPoints: incorrect boxOffset');
    } else if (cp0.sourceNode == cp1.sourceNode) {
      if (cp1.after) {
        if (cp0.after) {
          logging.logger.warn(
              'validateCheckPoints: duplicate after points');
        }
      } else {
        if (!cp0.after) {
          if (cp1.boxOffset - cp0.boxOffset !=
              cp1.offsetInNode - cp0.offsetInNode) {
            logging.logger.warn(
                'validateCheckPoints: boxOffset inconsistent with offsetInNode');
          }
        }
      }
    }
  }
};

export class BlockFormattingContext implements vtree.FormattingContext {
  constructor(private readonly parent: vtree.FormattingContext) {}

  /**
   * @override
   */
  getName() {return 'Block formatting context (BlockFormattingContext)';}

  /**
   * @override
   */
  isFirstTime(nodeContext, firstTime) {return firstTime;}

  /**
   * @override
   */
  getParent() {
    return this.parent;
  }

  /** @override */
  saveState() {}

  /** @override */
  restoreState(state) {}
}

export class Column extends vtree.Container {
  last: Node;
  viewDocument: Document;
  flowRootFormattingContext: vtree.FormattingContext = null;
  isFloat: boolean = false;
  isFootnote: boolean = false;
  startEdge: number = 0;
  endEdge: number = 0;
  beforeEdge: number = 0;
  afterEdge: number = 0;
  footnoteEdge: number = 0;
  box: geom.Rect = null;
  chunkPositions: vtree.ChunkPosition[] = null;
  bands: geom.Band[] = null;
  overflown: boolean = false;
  breakPositions: BreakPosition[] = null;
  pageBreakType: string|null = null;
  forceNonfitting: boolean = true;
  leftFloatEdge: number = 0;

  // bottom of the bottommost left float
  rightFloatEdge: number = 0;

  // bottom of the bottommost right float
  bottommostFloatTop: number = 0;

  // Top of the bottommost float
  stopAtOverflow: boolean = true;
  lastAfterPosition: vtree.NodePosition|null = null;
  fragmentLayoutConstraints: FragmentLayoutConstraint[] = [];
  pseudoParent: Column = null;
  nodeContextOverflowingDueToRepetitiveElements: vtree.NodeContext|null = null;
  blockDistanceToBlockEndFloats: number = NaN;
  computedBlockSize: any;

  constructor(
      element: Element, public layoutContext: vtree.LayoutContext,
      public clientLayout: vtree.ClientLayout,
      public readonly layoutConstraint: LayoutConstraint,
      public readonly pageFloatLayoutContext:
          pagefloat.PageFloatLayoutContext) {
    super(element);
    this.last = element.lastChild;
    this.viewDocument = element.ownerDocument;
    pageFloatLayoutContext.setContainer(this);
  }

  getTopEdge(): number {
    return this.vertical ? this.startEdge : this.beforeEdge;
  }

  getBottomEdge(): number {
    return this.vertical ? this.endEdge : this.afterEdge;
  }

  getLeftEdge(): number {
    return this.vertical ? this.afterEdge : this.startEdge;
  }

  getRightEdge(): number {
    return this.vertical ? this.beforeEdge : this.endEdge;
  }

  isFloatNodeContext(nodeContext: vtree.NodeContext): boolean {
    return !!nodeContext.floatSide && (!this.isFloat || !!nodeContext.parent);
  }

  stopByOverflow(nodeContext: vtree.NodeContext): boolean {
    return this.stopAtOverflow && !!nodeContext && nodeContext.overflow;
  }

  isOverflown(edge: number): boolean {
    if (this.vertical) {
      return edge < this.footnoteEdge;
    } else {
      return edge > this.footnoteEdge;
    }
  }

  getExclusions(): geom.Shape[] {
    const pageFloatExclusions =
        this.pageFloatLayoutContext.getFloatFragmentExclusions();
    return this.exclusions.concat(pageFloatExclusions);
  }

  openAllViews(position: vtree.NodePosition): task.Result<vtree.NodeContext> {
    const self = this;
    const frame: task.Frame<vtree.NodeContext> = task.newFrame('openAllViews');
    const steps = position.steps;
    self.layoutContext.setViewRoot(self.element, self.isFootnote);
    let stepIndex = steps.length - 1;
    let nodeContext = null;
    frame
        .loop(() => {
          while (stepIndex >= 0) {
            const prevContext = nodeContext;
            const step = steps[stepIndex];
            nodeContext =
                vtree.makeNodeContextFromNodePositionStep(step, prevContext);
            if (stepIndex === steps.length - 1 &&
                !nodeContext.formattingContext) {
              nodeContext.formattingContext = self.flowRootFormattingContext;
            }
            if (stepIndex == 0) {
              nodeContext.offsetInNode =
                  self.calculateOffsetInNodeForNodeContext(position);
              nodeContext.after = position.after;
              nodeContext.preprocessedTextContent =
                  position.preprocessedTextContent;
              if (nodeContext.after) {
                break;
              }
            }
            const r = self.layoutContext.setCurrent(
                nodeContext, stepIndex == 0 && nodeContext.offsetInNode == 0);
            stepIndex--;
            if (r.isPending()) {
              return r;
            }
          }
          return task.newResult(false);
        })
        .then(() => {
          asserts.assert(nodeContext);
          frame.finish(nodeContext);
        });
    return frame.result();
  }

  calculateOffsetInNodeForNodeContext(position: vtree.NodePosition):
      number {return position.preprocessedTextContent? resolveNewIndex(
              position.preprocessedTextContent, position.offsetInNode):
              position.offsetInNode;}

  /**
   * @param count first-XXX nesting identifier
   */
  maybePeelOff(position: vtree.NodeContext, count: number):
      task.Result<vtree.NodeContext> {
    if (position.firstPseudo && position.inline && !position.after &&
        position.firstPseudo.count == 0) {
      // first char
      if (position.viewNode.nodeType != 1) {
        const text = position.viewNode.textContent;
        const r = text.match(firstCharPattern);
        return this.layoutContext.peelOff(position, r[0].length);
      }
    }
    return (task.newResult(position) as task.Result<vtree.NodeContext>);
  }

  /**
   * Builds the view until a CSS box edge is reached.
   * @param position start source position.
   * @param checkPoints array to append
   *                      possible breaking points.
   * @return holding box edge position reached
   *                      or null if the source is exhausted.
   */
  buildViewToNextBlockEdge(
      position: vtree.NodeContext,
      checkPoints: vtree.NodeContext[]): task.Result<vtree.NodeContext> {
    const self = this;
    let violateConstraint = false;
    const frame: task.Frame<vtree.NodeContext> =
        task.newFrame('buildViewToNextBlockEdge');
    frame
        .loopWithFrame((bodyFrame) => {
          if (position.viewNode && !isSpecialNodeContext(position)) {
            checkPoints.push(position.copy());
          }
          self.maybePeelOff(position, 0).then((position1Param) => {
            const position1 = (position1Param as vtree.NodeContext);
            if (position1 !== position) {
              position = position1;
              if (!isSpecialNodeContext(position)) {
                checkPoints.push(position.copy());
              }
            }
            self.nextInTree(position).then((positionParam) => {
              position = (positionParam as vtree.NodeContext);
              if (!position) {
                // Exit the loop
                bodyFrame.breakLoop();
                return;
              }
              if (violateConstraint ||
                  !self.layoutConstraint.allowLayout(position)) {
                violateConstraint = true;
                position = position.modify();
                position.overflow = true;
              }
              if (self.isFloatNodeContext(position) && !self.vertical) {
                self.layoutFloatOrFootnote(position).then((positionParam) => {
                  position = (positionParam as vtree.NodeContext);
                  if (self.pageFloatLayoutContext.isInvalidated()) {
                    position = null;
                  }
                  if (!position) {
                    bodyFrame.breakLoop();
                    return;
                  }
                  bodyFrame.continueLoop();
                });
              } else if (!position.inline) {
                // Exit the loop
                bodyFrame.breakLoop();
              } else {
                // Continue the loop
                bodyFrame.continueLoop();
              }
            });
          });
        })
        .then(() => {
          frame.finish(position);
        });
    return frame.result();
  }

  nextInTree(position: vtree.NodeContext, atUnforcedBreak?: boolean):
      task.Result<vtree.NodeContext> {
    const cont = this.layoutContext.nextInTree(position, atUnforcedBreak);
    return processAfterIfContinues(cont, this);
  }

  /**
   * Builds the view for a single unbreakable element.
   * @param position start source position.
   * @return holding box edge position reached
   *       or null if the source is exhausted.
   */
  buildDeepElementView(position: vtree.NodeContext):
      task.Result<vtree.NodeContext> {
    if (!position.viewNode) {
      return task.newResult(position);
    }
    let checkPoints: vtree.NodeContext[] = [];
    const sourceNode = position.sourceNode;
    const self = this;
    const frame: task.Frame<vtree.NodeContext> =
        task.newFrame('buildDeepElementView');

    // TODO: end the loop based on depth, not sourceNode comparison
    frame
        .loopWithFrame((bodyFrame) => {
          if (position.viewNode && position.inline &&
              !isSpecialNodeContext(position)) {
            checkPoints.push(position.copy());
          } else {
            if (checkPoints.length > 0) {
              self.postLayoutBlock(position, checkPoints);
            }
            checkPoints = [];
          }
          self.maybePeelOff(position, 0).then((position1Param) => {
            const position1 = (position1Param as vtree.NodeContext);
            if (position1 !== position) {
              let p = position1;
              while (p && p.sourceNode != sourceNode) {
                p = p.parent;
              }
              if (p == null) {
                // outside of the subtree
                position = position1;
                bodyFrame.breakLoop();
                return;
              }
              if (!isSpecialNodeContext(position1)) {
                checkPoints.push(position1.copy());
              }
            }
            self.nextInTree(position1).then((positionParam) => {
              position = (positionParam as vtree.NodeContext);
              if (!position || position.sourceNode == sourceNode) {
                bodyFrame.breakLoop();
              } else if (!self.layoutConstraint.allowLayout(position)) {
                position = position.modify();
                position.overflow = true;
                if (self.stopAtOverflow) {
                  bodyFrame.breakLoop();
                } else {
                  bodyFrame.continueLoop();
                }
              } else {
                bodyFrame.continueLoop();
              }
            });
          });
        })
        .then(() => {
          if (checkPoints.length > 0) {
            self.postLayoutBlock(position, checkPoints);
          }
          frame.finish(position);
        });
    return frame.result();
  }

  /**
   * Create a single floating element (for exclusion areas).
   * @param ref container's child to insert float before (can be null).
   * @param side float side ("left" or "right").
   * @param width float inline dimension.
   * @param height float box progression dimension.
   * @return newly created float element.
   */
  createFloat(ref: Node, side: string, width: number, height: number): Element {
    const div = this.viewDocument.createElement('div');
    if (this.vertical) {
      if (height >= this.height) {
        height -= 0.1;
      }
      base.setCSSProperty(div, 'height', `${width}px`);
      base.setCSSProperty(div, 'width', `${height}px`);
    } else {
      if (width >= this.width) {
        width -= 0.1;
      }
      base.setCSSProperty(div, 'width', `${width}px`);
      base.setCSSProperty(div, 'height', `${height}px`);
    }
    base.setCSSProperty(div, 'float', side);
    base.setCSSProperty(div, 'clear', side);

    // enable to visualize
    // adapt.base.setCSSProperty(div, "background-color", "#50F0FF");
    this.element.insertBefore(div, ref);
    return div;
  }

  /**
   * Remove all the exclusion floats.
   */
  killFloats(): void {
    let c = this.element.firstChild;
    while (c) {
      const nc = c.nextSibling;
      if (c.nodeType == 1) {
        const e = (c as HTMLElement);
        const f = e.style.cssFloat;
        if (f == 'left' || f == 'right') {
          this.element.removeChild(e);
        } else {
          break;
        }
      }
      c = nc;
    }
  }

  /**
   * Create exclusion floats for a column.
   */
  createFloats(): void {
    const ref = this.element.firstChild;
    const bands = this.bands;
    const x1 = this.vertical ? this.getTopEdge() : this.getLeftEdge();
    const x2 = this.vertical ? this.getBottomEdge() : this.getRightEdge();
    for (const band of bands) {
      const height = band.y2 - band.y1;
      band.left = this.createFloat(ref, 'left', band.x1 - x1, height);
      band.right = this.createFloat(ref, 'right', x2 - band.x2, height);
    }
  }

  /**
   * @param nodeContext position after the block
   * @param checkPoints array of possible breaking points.
   * @param index index of the breaking point
   * @param boxOffset box offset
   * @return edge position
   */
  calculateEdge(
      nodeContext: vtree.NodeContext, checkPoints: vtree.NodeContext[],
      index: number, boxOffset: number): number {
    let edge;
    if (nodeContext && isOrphan(nodeContext.viewNode)) {
      return NaN;
    } else if (nodeContext && nodeContext.after && !nodeContext.inline) {
      edge = calculateEdge(nodeContext, this.clientLayout, 0, this.vertical);
      if (!isNaN(edge)) {
        return edge;
      }
    }
    nodeContext = checkPoints[index];
    let offset = boxOffset - nodeContext.boxOffset;
    while (true) {
      edge =
          calculateEdge(nodeContext, this.clientLayout, offset, this.vertical);
      if (!isNaN(edge)) {
        return edge;
      }
      if (offset > 0) {
        offset--;
        continue;
      }
      index--;
      if (index < 0) {
        return this.beforeEdge;
      }
      nodeContext = checkPoints[index];
      if (nodeContext.viewNode.nodeType != 1) {
        offset = nodeContext.viewNode.textContent.length;
      }
    }
  }

  /**
   * Parse CSS computed length (in pixels)
   * @param val CSS length in "px" units or a number.
   * @return value in pixels or 0 if not parsable
   */
  parseComputedLength(val: string|number): number {
    if (typeof val == 'number') {
      return val;
    }
    const r = val.match(/^(-?[0-9]*(\.[0-9]*)?)px$/);
    if (r) {
      return parseFloat(r[0]);
    }
    return 0;
  }

  /**
   * Reads element's computed CSS margin.
   */
  getComputedMargin(element: Element): geom.Insets {
    const style = this.clientLayout.getElementComputedStyle(element);
    const insets = new geom.Insets(0, 0, 0, 0);
    if (style) {
      insets.left = this.parseComputedLength(style.marginLeft);
      insets.top = this.parseComputedLength(style.marginTop);
      insets.right = this.parseComputedLength(style.marginRight);
      insets.bottom = this.parseComputedLength(style.marginBottom);
    }
    return insets;
  }

  /**
   * Reads element's computed padding + borders.
   */
  getComputedPaddingBorder(element: Element): geom.Insets {
    const style = this.clientLayout.getElementComputedStyle(element);
    const insets = new geom.Insets(0, 0, 0, 0);
    if (style) {
      insets.left = this.parseComputedLength(style.borderLeftWidth) +
          this.parseComputedLength(style.paddingLeft);
      insets.top = this.parseComputedLength(style.borderTopWidth) +
          this.parseComputedLength(style.paddingTop);
      insets.right = this.parseComputedLength(style.borderRightWidth) +
          this.parseComputedLength(style.paddingRight);
      insets.bottom = this.parseComputedLength(style.borderBottomWidth) +
          this.parseComputedLength(style.paddingBottom);
    }
    return insets;
  }

  /**
   * Reads element's computed CSS insets(margins + border + padding or margins :
   * depends on box-sizing)
   */
  getComputedInsets(element: Element): geom.Insets {
    const style = this.clientLayout.getElementComputedStyle(element);
    const insets = new geom.Insets(0, 0, 0, 0);
    if (style) {
      if (style.boxSizing == 'border-box') {
        return this.getComputedMargin(element);
      }
      insets.left = this.parseComputedLength(style.marginLeft) +
          this.parseComputedLength(style.borderLeftWidth) +
          this.parseComputedLength(style.paddingLeft);
      insets.top = this.parseComputedLength(style.marginTop) +
          this.parseComputedLength(style.borderTopWidth) +
          this.parseComputedLength(style.paddingTop);
      insets.right = this.parseComputedLength(style.marginRight) +
          this.parseComputedLength(style.borderRightWidth) +
          this.parseComputedLength(style.paddingRight);
      insets.bottom = this.parseComputedLength(style.marginBottom) +
          this.parseComputedLength(style.borderBottomWidth) +
          this.parseComputedLength(style.paddingBottom);
    }
    return insets;
  }

  /**
   * Set element's computed CSS insets to Column Container
   */
  setComputedInsets(element: Element, container: Column) {
    const style = this.clientLayout.getElementComputedStyle(element);
    if (style) {
      container.marginLeft = this.parseComputedLength(style.marginLeft);
      container.borderLeft = this.parseComputedLength(style.borderLeftWidth);
      container.paddingLeft = this.parseComputedLength(style.paddingLeft);
      container.marginTop = this.parseComputedLength(style.marginTop);
      container.borderTop = this.parseComputedLength(style.borderTopWidth);
      container.paddingTop = this.parseComputedLength(style.paddingTop);
      container.marginRight = this.parseComputedLength(style.marginRight);
      container.borderRight = this.parseComputedLength(style.borderRightWidth);
      container.paddingRight = this.parseComputedLength(style.paddingRight);
      container.marginBottom = this.parseComputedLength(style.marginBottom);
      container.borderBottom =
          this.parseComputedLength(style.borderBottomWidth);
      container.paddingBottom = this.parseComputedLength(style.paddingBottom);
    }
  }

  /**
   * Set element's computed width and height to Column Container
   */
  setComputedWidthAndHeight(element: Element, container: Column) {
    const style = this.clientLayout.getElementComputedStyle(element);
    if (style) {
      container.width = this.parseComputedLength(style.width);
      container.height = this.parseComputedLength(style.height);
    }
  }

  /**
   * Layout a single unbreakable element.
   */
  layoutUnbreakable(nodeContextIn: vtree.NodeContext):
      task.Result<vtree.NodeContext> {
    return this.buildDeepElementView(nodeContextIn);
  }

  /**
   * Layout a single float element.
   */
  layoutFloat(nodeContext: vtree.NodeContext): task.Result<vtree.NodeContext> {
    const self = this;
    const frame: task.Frame<vtree.NodeContext> = task.newFrame('layoutFloat');
    const element = (nodeContext.viewNode as Element);
    const floatSide = (nodeContext.floatSide as string);
    base.setCSSProperty(element, 'float', 'none');
    base.setCSSProperty(element, 'display', 'inline-block');
    base.setCSSProperty(element, 'vertical-align', 'top');
    self.buildDeepElementView(nodeContext).then((nodeContextAfter) => {
      const floatBBox = self.clientLayout.getElementClientRect(element);
      const margin = self.getComputedMargin(element);
      let floatBox = new geom.Rect(
          floatBBox.left - margin.left, floatBBox.top - margin.top,
          floatBBox.right + margin.right, floatBBox.bottom + margin.bottom);
      let x1 = self.startEdge;
      let x2 = self.endEdge;
      let parent = nodeContext.parent;
      while (parent && parent.inline) {
        parent = parent.parent;
      }
      if (parent) {
        // Position it at the parent element's edge.
        // We need to get the edge of the parent's content area, calling
        // getElementClientRect will also give us borders. Avoid it by creating
        // a temporary element and using it for measurment.
        let probe = parent.viewNode.ownerDocument.createElement('div');
        probe.style.left = '0px';
        probe.style.top = '0px';
        if (self.vertical) {
          probe.style.bottom = '0px';
          probe.style.width = '1px';
        } else {
          probe.style.right = '0px';
          probe.style.height = '1px';
        }
        parent.viewNode.appendChild(probe);
        const parentBox = self.clientLayout.getElementClientRect(probe);
        x1 = Math.max(self.getStartEdge(parentBox), x1);
        x2 = Math.min(self.getEndEdge(parentBox), x2);
        parent.viewNode.removeChild(probe);
        const floatBoxMeasure = self.vertical ? floatBox.y2 - floatBox.y1 :
                                                floatBox.x2 - floatBox.x1;
        if (floatSide == 'left') {
          x2 = Math.max(x2, x1 + floatBoxMeasure);
        } else {
          x1 = Math.min(x1, x2 - floatBoxMeasure);
        }

        // Move the float below the block parent.
        // Otherwise, if the float is attached to an inline box with 'position:
        // relative', the absolute positioning of the float gets broken, since
        // the inline parent can be pushed horizontally by exclusion floats
        // after the layout of the float is done.
        parent.viewNode.appendChild(nodeContext.viewNode);
      }

      // box is rotated for vertical orientation
      let box = new geom.Rect(
          x1, self.getBoxDir() * self.beforeEdge, x2,
          self.getBoxDir() * self.afterEdge);
      let floatHorBox = floatBox;
      if (self.vertical) {
        floatHorBox = geom.rotateBox(floatBox);
      }
      const dir = self.getBoxDir();
      if (floatHorBox.y1 < self.bottommostFloatTop * dir) {
        const boxExtent = floatHorBox.y2 - floatHorBox.y1;
        floatHorBox.y1 = self.bottommostFloatTop * dir;
        floatHorBox.y2 = floatHorBox.y1 + boxExtent;
      }
      geom.positionFloat(box, self.bands, floatHorBox, floatSide);
      if (self.vertical) {
        floatBox = geom.unrotateBox(floatHorBox);
      }
      const insets = self.getComputedInsets(element);
      base.setCSSProperty(
          element, 'width',
          `${floatBox.x2 - floatBox.x1 - insets.left - insets.right}px`);
      base.setCSSProperty(
          element, 'height',
          `${floatBox.y2 - floatBox.y1 - insets.top - insets.bottom}px`);
      base.setCSSProperty(element, 'position', 'absolute');
      asserts.assert(nodeContext.display);
      base.setCSSProperty(element, 'display', nodeContext.display);
      let offsets;
      let containingBlockForAbsolute = null;
      if (parent) {
        if (parent.containingBlockForAbsolute) {
          containingBlockForAbsolute = parent;
        } else {
          containingBlockForAbsolute = parent.getContainingBlockForAbsolute();
        }
      }
      if (containingBlockForAbsolute) {
        let probe =
            containingBlockForAbsolute.viewNode.ownerDocument.createElement(
                'div');
        probe.style.position = 'absolute';
        if (containingBlockForAbsolute.vertical) {
          probe.style.right = '0';
        } else {
          probe.style.left = '0';
        }
        probe.style.top = '0';
        containingBlockForAbsolute.viewNode.appendChild(probe);
        offsets = self.clientLayout.getElementClientRect(probe);
        containingBlockForAbsolute.viewNode.removeChild(probe);
      } else {
        offsets = {
          left: self.getLeftEdge() - self.paddingLeft,
          right: self.getRightEdge() + self.paddingRight,
          top: self.getTopEdge() - self.paddingTop
        };
      }
      if (containingBlockForAbsolute ? containingBlockForAbsolute.vertical :
                                       self.vertical) {
        base.setCSSProperty(
            element, 'right', `${offsets.right - floatBox.x2}px`);
      } else {
        base.setCSSProperty(element, 'left', `${floatBox.x1 - offsets.left}px`);
      }
      base.setCSSProperty(element, 'top', `${floatBox.y1 - offsets.top}px`);
      if (nodeContext.clearSpacer) {
        nodeContext.clearSpacer.parentNode.removeChild(nodeContext.clearSpacer);
        nodeContext.clearSpacer = null;
      }
      const floatBoxEdge = self.vertical ? floatBox.x1 : floatBox.y2;
      const floatBoxTop = self.vertical ? floatBox.x2 : floatBox.y1;

      // TODO: subtract after margin when determining overflow.
      if (!self.isOverflown(floatBoxEdge) || self.breakPositions.length == 0) {
        // no overflow
        self.killFloats();
        box = new geom.Rect(
            self.getLeftEdge(), self.getTopEdge(), self.getRightEdge(),
            self.getBottomEdge());
        if (self.vertical) {
          box = geom.rotateBox(box);
        }
        geom.addFloatToBands(box, self.bands, floatHorBox, null, floatSide);
        self.createFloats();
        if (floatSide == 'left') {
          self.leftFloatEdge = floatBoxEdge;
        } else {
          self.rightFloatEdge = floatBoxEdge;
        }
        self.bottommostFloatTop = floatBoxTop;
        self.updateMaxReachedAfterEdge(floatBoxEdge);
        frame.finish(nodeContextAfter);
      } else {
        nodeContext = nodeContext.modify();
        nodeContext.overflow = true;
        frame.finish(nodeContext);
      }
    });
    return frame.result();
  }

  setupFloatArea(
      area: PageFloatArea, floatReference: pagefloat.FloatReference,
      floatSide: string, anchorEdge: number|null,
      strategy: pagefloat.PageFloatLayoutStrategy,
      condition: pagefloat.PageFloatPlacementCondition): boolean {
    const floatLayoutContext = this.pageFloatLayoutContext;
    const floatContainer = floatLayoutContext.getContainer(floatReference);
    const element = area.element;
    floatContainer.element.parentNode.appendChild(element);
    area.isFloat = true;
    area.originX = floatContainer.originX;
    area.originY = floatContainer.originY;
    area.vertical = floatContainer.vertical;
    area.marginLeft = area.marginRight = area.marginTop = area.marginBottom = 0;
    area.borderLeft = area.borderRight = area.borderTop = area.borderBottom = 0;
    area.paddingLeft = area.paddingRight = area.paddingTop =
        area.paddingBottom = 0;
    area.exclusions = (floatContainer.exclusions || []).concat();
    area.forceNonfitting = !floatLayoutContext.hasFloatFragments();
    area.innerShape = null;
    const containingBlockRect = floatContainer.getPaddingRect();
    area.setHorizontalPosition(
        containingBlockRect.x1 - floatContainer.originX,
        containingBlockRect.x2 - containingBlockRect.x1);
    area.setVerticalPosition(
        containingBlockRect.y1 - floatContainer.originY,
        containingBlockRect.y2 - containingBlockRect.y1);
    strategy.adjustPageFloatArea(area, floatContainer, this);

    // Calculate bands from the exclusions before setting float area dimensions
    area.init();
    const fitWithinContainer = !!floatLayoutContext.setFloatAreaDimensions(
        area, floatReference, floatSide, anchorEdge, true,
        !floatLayoutContext.hasFloatFragments(), condition);
    if (fitWithinContainer) {
      // New dimensions have been set, remove exclusion floats and re-init
      area.killFloats();
      area.init();
    } else {
      floatContainer.element.parentNode.removeChild(element);
    }
    return fitWithinContainer;
  }

  createPageFloatArea(
      float: pagefloat.PageFloat|null, floatSide: string,
      anchorEdge: number|null, strategy: pagefloat.PageFloatLayoutStrategy,
      condition: pagefloat.PageFloatPlacementCondition): PageFloatArea|null {
    const floatAreaElement = this.element.ownerDocument.createElement('div');
    base.setCSSProperty(floatAreaElement, 'position', 'absolute');
    const parentPageFloatLayoutContext =
        this.pageFloatLayoutContext.getPageFloatLayoutContext(
            float.floatReference);

    // TODO: establish how to specify an appropriate generating element for the
    // new page float layout context
    const pageFloatLayoutContext = new pagefloat.PageFloatLayoutContext(
        null, pagefloat.FloatReference.COLUMN, null,
        this.pageFloatLayoutContext.flowName, float.nodePosition, null, null);
    const parentContainer = parentPageFloatLayoutContext.getContainer();
    const floatArea = new PageFloatArea(
        floatSide, floatAreaElement, this.layoutContext.clone(),
        this.clientLayout, this.layoutConstraint, pageFloatLayoutContext,
        parentContainer);
    pageFloatLayoutContext.setContainer(floatArea);
    if (this.setupFloatArea(
            floatArea, float.floatReference, floatSide, anchorEdge, strategy,
            condition)) {
      return floatArea;
    } else {
      return null;
    }
  }

  layoutSinglePageFloatFragment(
      continuations: pagefloat.PageFloatContinuation[], floatSide: string,
      clearSide: string|null, allowFragmented: boolean,
      strategy: pagefloat.PageFloatLayoutStrategy, anchorEdge: number|null,
      pageFloatFragment?: pagefloat.PageFloatFragment|
      null): task.Result<SinglePageFloatLayoutResult> {
    const context = this.pageFloatLayoutContext;
    const originalContinuations =
        pageFloatFragment ? pageFloatFragment.continuations : [];
    continuations = originalContinuations.concat(continuations);
    const firstFloat = continuations[0].float;
    const condition = context.getPageFloatPlacementCondition(
        firstFloat, floatSide, clearSide);
    const floatArea = this.createPageFloatArea(
        firstFloat, floatSide, anchorEdge, strategy, condition);
    const result: SinglePageFloatLayoutResult = {
      floatArea,
      pageFloatFragment: null,
      newPosition: null
    };
    if (!floatArea) {
      return task.newResult(result);
    }
    const frame = task.newFrame('layoutSinglePageFloatFragment');
    let failed = false;
    let i = 0;
    frame
        .loopWithFrame((loopFrame) => {
          if (i >= continuations.length) {
            loopFrame.breakLoop();
            return;
          }
          const c = continuations[i];
          const floatChunkPosition = new vtree.ChunkPosition(c.nodePosition);
          floatArea.layout(floatChunkPosition, true).then((newPosition) => {
            result.newPosition = newPosition;
            if (!newPosition || allowFragmented) {
              i++;
              loopFrame.continueLoop();
            } else {
              failed = true;
              loopFrame.breakLoop();
            }
          });
        })
        .then(() => {
          if (!failed) {
            asserts.assert(floatArea);
            const logicalFloatSide = context.setFloatAreaDimensions(
                floatArea, firstFloat.floatReference, floatSide, anchorEdge,
                false, allowFragmented, condition);
            if (!logicalFloatSide) {
              failed = true;
            } else {
              const newFragment = strategy.createPageFloatFragment(
                  continuations, logicalFloatSide, floatArea,
                  !!result.newPosition);
              context.addPageFloatFragment(newFragment, true);
              result.pageFloatFragment = newFragment;
            }
          }
          frame.finish(result);
        });
    return frame.result();
  }

  layoutPageFloatInner(
      continuation: pagefloat.PageFloatContinuation,
      strategy: pagefloat.PageFloatLayoutStrategy, anchorEdge: number|null,
      pageFloatFragment?: pagefloat.PageFloatFragment): task.Result<boolean> {
    const context = this.pageFloatLayoutContext;
    const float = continuation.float;
    context.stashEndFloatFragments(float);

    function cancelLayout(floatArea, pageFloatFragment) {
      if (pageFloatFragment) {
        context.removePageFloatFragment(pageFloatFragment, true);
      } else if (floatArea) {
        floatArea.element.parentNode.removeChild(floatArea.element);
      }
      context.restoreStashedFragments(float.floatReference);
      context.deferPageFloat(continuation);
    }
    const frame: task.Frame<boolean> = task.newFrame('layoutPageFloatInner');
    const self = this;
    this.layoutSinglePageFloatFragment(
            [continuation], float.floatSide, float.clearSide,
            !context.hasFloatFragments(), strategy, anchorEdge,
            pageFloatFragment)
        .then((result) => {
          const floatArea = result.floatArea;
          const newFragment = result.pageFloatFragment;
          const newPosition = result.newPosition;
          if (newFragment) {
            self.layoutStashedPageFloats(
                    float.floatReference, [pageFloatFragment])
                .then((success) => {
                  if (success) {
                    // Add again to invalidate the context
                    asserts.assert(newFragment);
                    context.addPageFloatFragment(newFragment);
                    context.discardStashedFragments(float.floatReference);
                    if (newPosition) {
                      const continuation = new pagefloat.PageFloatContinuation(
                          float, newPosition.primary);
                      context.deferPageFloat(continuation);
                    }
                    frame.finish(true);
                  } else {
                    cancelLayout(floatArea, newFragment);
                    frame.finish(false);
                  }
                });
          } else {
            cancelLayout(floatArea, newFragment);
            frame.finish(false);
          }
        });
    return frame.result();
  }

  /**
   * @returns Represents if the layout was succeeded or not
   */
  private layoutStashedPageFloats(
      floatReference: pagefloat.FloatReference,
      excluded: pagefloat.PageFloatFragment[]): task.Result<boolean> {
    const context = this.pageFloatLayoutContext;
    const stashedFloatFragments =
        context.getStashedFloatFragments(floatReference);
    const newFloatAreas = [];
    const newFragments = [];
    let failed = false;
    const frame = task.newFrame('layoutStashedPageFloats');
    const self = this;
    let i = 0;
    frame
        .loopWithFrame((loopFrame) => {
          if (i >= stashedFloatFragments.length) {
            loopFrame.breakLoop();
            return;
          }
          const stashedFragment = stashedFloatFragments[i];
          if (excluded.includes(stashedFragment)) {
            i++;
            loopFrame.continueLoop();
            return;
          }
          const strategy =
              (new pagefloat.PageFloatLayoutStrategyResolver())
                  .findByFloat(stashedFragment.continuations[0].float);

          // Value of 'clear' is irrelevant when laying out stashed floats
          // since whether the 'clear' value allows placing the float
          // here is already resolved.
          self.layoutSinglePageFloatFragment(
                  stashedFragment.continuations, stashedFragment.floatSide,
                  null, false, strategy, null)
              .then((result) => {
                const floatArea = result.floatArea;
                if (floatArea) {
                  newFloatAreas.push(floatArea);
                }
                const fragment = result.pageFloatFragment;
                if (fragment) {
                  newFragments.push(fragment);
                  i++;
                  loopFrame.continueLoop();
                } else {
                  failed = true;
                  loopFrame.breakLoop();
                }
              });
        })
        .then(() => {
          if (failed) {
            newFragments.forEach((fragment) => {
              context.removePageFloatFragment(fragment, true);
            });
            newFloatAreas.forEach((area) => {
              const elem = area.element;
              if (elem && elem.parentNode) {
                elem.parentNode.removeChild(elem);
              }
            });
          } else {
            stashedFloatFragments.forEach((fragment) => {
              const elem = fragment.area.element;
              if (elem && elem.parentNode) {
                elem.parentNode.removeChild(elem);
              }
            });
          }
          frame.finish(!failed);
        });
    return frame.result();
  }

  setFloatAnchorViewNode(nodeContext: vtree.NodeContext): vtree.NodeContext {
    const parent = nodeContext.viewNode.parentNode;
    const anchor = parent.ownerDocument.createElement('span');
    anchor.setAttribute(vtree.SPECIAL_ATTR, '1');
    if (nodeContext.floatSide === 'footnote') {
      // Defaults for footnote-call, can be overriden by the stylesheet.
      this.layoutContext.applyPseudoelementStyle(
          nodeContext, 'footnote-call', anchor);
    }
    parent.appendChild(anchor);
    parent.removeChild(nodeContext.viewNode);
    const nodeContextAfter = nodeContext.modify();
    nodeContextAfter.after = true;
    nodeContextAfter.viewNode = anchor;
    return nodeContextAfter;
  }

  resolveFloatReferenceFromColumnSpan(
      floatReference: pagefloat.FloatReference, columnSpan: Val,
      nodeContext: vtree.NodeContext): task.Result<pagefloat.FloatReference> {
    const self = this;
    const frame =
        (task.newFrame('resolveFloatReferenceFromColumnSpan') as
         task.Frame<pagefloat.FloatReference>);
    const columnContext = this.pageFloatLayoutContext;
    const regionContext = columnContext.getPageFloatLayoutContext(
        pagefloat.FloatReference.REGION);
    const isRegionWider =
        columnContext.getContainer().width < regionContext.getContainer().width;
    if (isRegionWider && floatReference === pagefloat.FloatReference.COLUMN) {
      if (columnSpan === ident.auto) {
        this.buildDeepElementView(nodeContext.copy()).then((position) => {
          const element = (position.viewNode as Element);
          let inlineSize =
              getSize(self.clientLayout, element, [
                Size.MIN_CONTENT_INLINE_SIZE
              ])[Size.MIN_CONTENT_INLINE_SIZE];
          const margin = self.getComputedMargin(element);
          if (self.vertical) {
            inlineSize += margin.top + margin.bottom;
          } else {
            inlineSize += margin.left + margin.right;
          }
          if (inlineSize > self.width) {
            frame.finish(pagefloat.FloatReference.REGION);
          } else {
            frame.finish(floatReference);
          }
        });
      } else if (columnSpan === ident.all) {
        frame.finish(pagefloat.FloatReference.REGION);
      } else {
        frame.finish(floatReference);
      }
    } else {
      frame.finish(floatReference);
    }
    return frame.result();
  }

  layoutPageFloat(nodeContext: vtree.NodeContext):
      task.Result<vtree.NodeContext> {
    const self = this;
    const context = this.pageFloatLayoutContext;
    const strategy = (new pagefloat.PageFloatLayoutStrategyResolver())
                         .findByNodeContext(nodeContext);
    let cont: task.Result<pagefloat.PageFloat>;
    const float =
        context.findPageFloatByNodePosition(nodeContext.toNodePosition());
    if (!float) {
      cont = strategy.createPageFloat(nodeContext, context, this);
    } else {
      cont = task.newResult(float);
    }
    return cont.thenAsync((float) => {
      const nodePosition = vtree.newNodePositionFromNodeContext(nodeContext, 0);
      const nodeContextAfter = self.setFloatAnchorViewNode(nodeContext);
      const pageFloatFragment = strategy.findPageFloatFragment(float, context);
      const continuation =
          new pagefloat.PageFloatContinuation(float, nodePosition);
      if (pageFloatFragment && pageFloatFragment.hasFloat(float)) {
        context.registerPageFloatAnchor(float, nodeContextAfter.viewNode);
        return task.newResult((nodeContextAfter as vtree.NodeContext));
      } else if (context.isForbidden(float) ||
          context.hasPrecedingFloatsDeferredToNext(float)) {
        context.deferPageFloat(continuation);
        context.registerPageFloatAnchor(float, nodeContextAfter.viewNode);
        return task.newResult((nodeContextAfter as vtree.NodeContext));
      } else if (self.nodeContextOverflowingDueToRepetitiveElements) {
        return task.newResult(null);
      } else {
        const edge = calculateEdge(
            nodeContextAfter, self.clientLayout, 0, self.vertical);
        if (self.isOverflown(edge)) {
          return task.newResult(nodeContextAfter);
        } else {
          return self
              .layoutPageFloatInner(
                  continuation, strategy, edge, pageFloatFragment)
              .thenAsync((success) => {
                asserts.assert(float);
                if (!success) {
                  context.registerPageFloatAnchor(
                      float, nodeContextAfter.viewNode);
                  return task.newResult(nodeContextAfter);
                } else {
                  return task.newResult(null);
                }
              });
        }
      }
    });
  }

  createJustificationAdjustmentElement(
      insertionPoint: Node, doc: Document, parentNode: Node,
      vertical: boolean): HTMLElement {
    const span = (doc.createElement('span') as HTMLElement);
    span.style.visibility = 'hidden';
    span.style.verticalAlign = 'top';
    span.setAttribute(vtree.SPECIAL_ATTR, '1');
    const inner = (doc.createElement('span') as HTMLElement);
    inner.style.fontSize = '0';
    inner.style.lineHeight = '0';
    inner.textContent = ' #';
    span.appendChild(inner);

    // Measure inline-start and inline-end edge positions of the line box,
    // taking (exclusion) floats into consideration
    span.style.display = 'block';
    span.style.textIndent = '0';
    span.style.textAlign = 'left';
    parentNode.insertBefore(span, insertionPoint);
    const leftPos = this.clientLayout.getElementClientRect(inner);
    span.style.textAlign = 'right';
    const rightPos = this.clientLayout.getElementClientRect(inner);
    span.style.textAlign = '';
    if (base.checkInlineBlockJustificationBug(document.body)) {
      // For Chrome
      span.style.display = 'inline';
    } else {
      // For Firefox, Edge and IE
      span.style.display = 'inline-block';
    }
    const padding =
        vertical ? rightPos.top - leftPos.top : rightPos.left - leftPos.left;
    const paddingStr = padding >= 1 ? `${padding - 1}px` : '100%';
    if (vertical) {
      span.style.paddingTop = paddingStr;
    } else {
      span.style.paddingLeft = paddingStr;
    }
    return span;
  }

  addAndAdjustJustificationElement(
      nodeContext: vtree.NodeContext, insertAfter: boolean, node: Node,
      insertionPoint: Node, doc: Document, parentNode: Node): HTMLElement {
    fixJustificationOnHyphen(nodeContext, insertAfter, node, insertionPoint);
    return this.createJustificationAdjustmentElement(
        insertionPoint, doc, parentNode, nodeContext.vertical);
  }

  compensateJustificationLineHeight(
      span: Element, br: Element, nodeContext: vtree.NodeContext) {
    const spanRect = this.clientLayout.getElementClientRect(span);
    const brRect = this.clientLayout.getElementClientRect(br);
    if (nodeContext.vertical) {
      (br as HTMLElement).style.marginRight = `${brRect.right - spanRect.right}px`;
      (br as HTMLElement).style.width = '0px';
    } else {
      (br as HTMLElement).style.marginTop = `${spanRect.top - brRect.top}px`;
      (br as HTMLElement).style.height = '0px';
    }
    br.setAttribute(vtree.SPECIAL_ATTR, '1');
  }

  /**
   * Fix justification of the last line of text broken across pages (if
   * needed).
   */
  fixJustificationIfNeeded(
      nodeContext: vtree.NodeContext, endOfColumn: boolean): void {
    if (nodeContext.after && !nodeContext.inline) {
      return;
    }
    if (endOfColumn) {
      let textAlign = '';
      for (let parent = nodeContext.parent; parent && !textAlign;
           parent = parent.parent) {
        if (!parent.inline && parent.viewNode) {
          textAlign = (parent.viewNode as HTMLElement).style.textAlign;
        }
      }
      if (textAlign !== 'justify') {
        return;
      }
    }
    const node = nodeContext.viewNode;
    const doc = node.ownerDocument;
    const insertAfter =
        endOfColumn && (nodeContext.after || node.nodeType != 1);
    let insertionPoint = insertAfter ? node.nextSibling : node;
    if (insertionPoint && !insertionPoint.parentNode) {
      // Possible if removeSelf = false in finishBreak()
      insertionPoint = null;
    }
    const parentNode =
        node.parentNode || nodeContext.parent && nodeContext.parent.viewNode;
    if (!parentNode) {
      // Possible if nothing was added to the column
      return;
    }
    const span = this.addAndAdjustJustificationElement(
        nodeContext, insertAfter, node, insertionPoint, doc, parentNode);
    if (!endOfColumn) {
      const br = (doc.createElement('div') as HTMLElement);
      parentNode.insertBefore(br, insertionPoint);
      this.compensateJustificationLineHeight(span, br, nodeContext);
    }
  }

  processLineStyling(
      nodeContext: vtree.NodeContext, resNodeContext: vtree.NodeContext,
      checkPoints: vtree.NodeContext[]): task.Result<vtree.NodeContext> {
    const self = this;
    const frame: task.Frame<vtree.NodeContext> =
        task.newFrame('processLineStyling');
    if (DEBUG) {
      validateCheckPoints(checkPoints);
    }
    let lastCheckPoints = checkPoints.concat([]);

    // make a copy
    checkPoints.splice(0, checkPoints.length);

    // make empty
    let totalLineCount = 0;
    let firstPseudo = nodeContext.firstPseudo;

    // :first-letter is not processed here
    if (firstPseudo.count == 0) {
      firstPseudo = firstPseudo.outer;
    }

    // move to line pseudoelement (if any)
    frame
        .loopWithFrame((loopFrame) => {
          if (!firstPseudo) {
            loopFrame.breakLoop();
            return;
          }
          const linePositions = self.findLinePositions(lastCheckPoints);
          const count = firstPseudo.count - totalLineCount;
          if (linePositions.length <= count) {
            loopFrame.breakLoop();
            return;
          }
          const lineBreak = self.findAcceptableBreakInside(
              lastCheckPoints, linePositions[count - 1], true);
          if (lineBreak == null) {
            loopFrame.breakLoop();
            return;
          }
          self.finishBreak(lineBreak, false, false).then(() => {
            totalLineCount += count;
            self.layoutContext.peelOff(lineBreak, 0)
                .then((resNodeContextParam) => {
                  nodeContext = resNodeContextParam;
                  self.fixJustificationIfNeeded(nodeContext, false);
                  firstPseudo = nodeContext.firstPseudo;
                  lastCheckPoints = [];

                  // Wipe out line breaks inside pseudoelements
                  self.buildViewToNextBlockEdge(nodeContext, lastCheckPoints)
                      .then((resNodeContextParam) => {
                        resNodeContext = resNodeContextParam;
                        loopFrame.continueLoop();
                      });
                });
          });
        })
        .then(() => {
          Array.prototype.push.apply(checkPoints, lastCheckPoints);
          if (DEBUG) {
            validateCheckPoints(checkPoints);
          }
          frame.finish(resNodeContext);
        });
    return frame.result();
  }

  isLoneImage(checkPoints: vtree.NodeContext[]): boolean {
    if (checkPoints.length != 2 && this.breakPositions.length > 0) {
      return false;
    }
    return checkPoints[0].sourceNode == checkPoints[1].sourceNode &&
        mediaTags[(checkPoints[0].sourceNode as Element).localName];
  }

  getTrailingMarginEdgeAdjustment(trailingEdgeContexts: vtree.NodeContext[]):
      number {
    // Margins push the computed height, but are not counted as overflow. We
    // need to find the overall collapsed margin from all enclosed blocks.
    let maxPos = 0;
    let minNeg = 0;
    for (let i = trailingEdgeContexts.length - 1; i >= 0; i--) {
      const nodeContext = trailingEdgeContexts[i];
      if (!nodeContext.after || !nodeContext.viewNode ||
          nodeContext.viewNode.nodeType != 1) {
        break;
      }
      const margin = this.getComputedMargin((nodeContext.viewNode as Element));
      const m = this.vertical ? -margin.left : margin.bottom;
      if (m > 0) {
        maxPos = Math.max(maxPos, m);
      } else {
        minNeg = Math.min(minNeg, m);
      }
    }
    return maxPos - minNeg;
  }

  /**
   * Layout a single CSS box.
   */
  layoutBreakableBlock(nodeContext: vtree.NodeContext):
      task.Result<vtree.NodeContext> {
    const self = this;
    const frame: task.Frame<vtree.NodeContext> =
        task.newFrame('layoutBreakableBlock');
    const checkPoints: vtree.NodeContext[] = [];
    self.buildViewToNextBlockEdge(nodeContext, checkPoints)
        .then((resNodeContext) => {
          // at this point a single block was appended to the column
          // flowPosition is either null or
          //  - if !after: contains view for the next block element
          //  - if after: contains view for the enclosing block element
          const checkPointIndex = checkPoints.length - 1;
          if (checkPointIndex < 0) {
            frame.finish(resNodeContext);
            return;
          }

          // Record the height
          // TODO: should this be done after first-line calculation?
          let edge = self.calculateEdge(
              resNodeContext, checkPoints, checkPointIndex,
              checkPoints[checkPointIndex].boxOffset);
          let overflown = false;
          if (!resNodeContext || !isOrphan(resNodeContext.viewNode)) {
            const offsets = calculateOffset(
                resNodeContext,
                repetitiveelements.collectElementsOffset(self));
            overflown = self.isOverflown(
                edge + (self.vertical ? -1 : 1) * offsets.minimum);
            if (self.isOverflown(
                    edge + (self.vertical ? -1 : 1) * offsets.current) &&
                !self.nodeContextOverflowingDueToRepetitiveElements) {
              self.nodeContextOverflowingDueToRepetitiveElements =
                  resNodeContext;
            }
          }
          if (resNodeContext == null) {
            edge += self.getTrailingMarginEdgeAdjustment(checkPoints);
          }
          self.updateMaxReachedAfterEdge(edge);
          let lineCont;
          if (nodeContext.firstPseudo) {
            // possibly need to deal with :first-line and friends
            lineCont = self.processLineStyling(
                nodeContext, resNodeContext, checkPoints);
          } else {
            lineCont = task.newResult(resNodeContext);
          }
          lineCont.then((nodeContext) => {
            self.postLayoutBlock(nodeContext, checkPoints);
            if (checkPoints.length > 0) {
              self.saveBoxBreakPosition(checkPoints);

              // TODO: how to signal overflow in the last pagargaph???
              if (overflown && !self.isLoneImage(checkPoints) && nodeContext) {
                nodeContext = nodeContext.modify();
                nodeContext.overflow = true;
              }
            }
            frame.finish(nodeContext);
          });
        });
    return frame.result();
  }

  postLayoutBlock(
      nodeContext: vtree.NodeContext, checkPoints: vtree.NodeContext[]) {
    const hooks: PostLayoutBlockHook[] = plugin.getHooksForName(
        plugin.HOOKS.POST_LAYOUT_BLOCK);
    hooks.forEach((hook) => {
      hook(nodeContext, checkPoints, this);
    });
  }

  findEndOfLine(
      linePosition: number, checkPoints: vtree.NodeContext[],
      isUpdateMaxReachedAfterEdge: boolean):
      {nodeContext: vtree.NodeContext, index: number, checkPointIndex: number} {
    if (DEBUG) {
      validateCheckPoints(checkPoints);
    }

    // Workaround for Blink not returning correct fractional values for
    // Range.getClientRects.
    // https://bugs.chromium.org/p/chromium/issues/detail?id=629828
    const effectiveLinePosition =
        this.vertical ? linePosition - 1 : linePosition + 1;

    // find the first character which is out
    let lowCP = 0;
    let low = checkPoints[0].boxOffset;
    let low1 = lowCP;
    let highCP = checkPoints.length - 1;
    let high = checkPoints[highCP].boxOffset;
    let mid;
    while (low < high) {
      mid = low + Math.ceil((high - low) / 2);

      // find the node which contains mid index
      low1 = lowCP;
      let high1 = highCP;
      while (low1 < high1) {
        const mid1 = low1 + Math.ceil((high1 - low1) / 2);
        if (checkPoints[mid1].boxOffset > mid) {
          high1 = mid1 - 1;
        } else {
          low1 = mid1;
        }
      }
      const edge = this.calculateEdge(null, checkPoints, low1, mid);
      if (this.vertical ? edge <= effectiveLinePosition :
                          edge >= effectiveLinePosition) {
        high = mid - 1;
        while (checkPoints[low1].boxOffset == mid) {
          low1--;
        }
        highCP = low1;
      } else {
        if (isUpdateMaxReachedAfterEdge) {
          this.updateMaxReachedAfterEdge(edge);
        }
        low = mid;
        lowCP = low1;
      }
    }
    return {nodeContext: checkPoints[low1], index: low, checkPointIndex: low1};
  }

  findAcceptableBreakInside(
      checkPoints: vtree.NodeContext[], edgePosition: number,
      force: boolean): vtree.NodeContext {
    const position = this.findEndOfLine(edgePosition, checkPoints, true);
    let nodeContext = position.nodeContext;
    const viewNode = nodeContext.viewNode;
    if (viewNode.nodeType != 1) {
      const textNode = (viewNode as Text);
      const textNodeBreaker = this.resolveTextNodeBreaker(nodeContext);
      nodeContext = textNodeBreaker.breakTextNode(
          textNode, nodeContext, position.index, checkPoints,
          position.checkPointIndex, force);
    }
    this.clearOverflownViewNodes(nodeContext, false);
    return nodeContext;
  }

  resolveTextNodeBreaker(nodeContext: vtree.NodeContext): TextNodeBreaker {
    const hooks: ResolveTextNodeBreakerHook[] =
        plugin.getHooksForName(
            plugin.HOOKS.RESOLVE_TEXT_NODE_BREAKER);
    return hooks.reduce(
        (prev, hook) => hook(nodeContext) || prev, TextNodeBreaker.instance);
  }

  /**
   * Read ranges skipping special elments
   */
  getRangeBoxes(start: Node, end: Node): vtree.ClientRect[] {
    const arr = [];
    const range = start.ownerDocument.createRange();
    let wentUp = false;
    let node = start;
    let lastGood = null;
    let haveStart = false;
    let endNotReached = true;
    while (endNotReached) {
      let seekRange = true;
      do {
        let next = null;
        if (node == end) {
          if (end.nodeType === 1) {
            // If end is an element, continue traversing its children to find
            // the last text node inside it. Finish when end has no child or
            // when came back from its children (wentUp==true).
            endNotReached = !(!end.firstChild || wentUp);
          } else {
            endNotReached = false;
          }
        }
        if (node.nodeType != 1) {
          if (!haveStart) {
            range.setStartBefore(node);
            haveStart = true;
          }
          lastGood = node;
        } else if (wentUp) {
          wentUp = false;
        } else if (isSpecial((node as Element))) {
          // Skip special
          seekRange = !haveStart;
        } else {
          next = node.firstChild;
        }
        if (!next) {
          next = node.nextSibling;
          if (!next) {
            wentUp = true;
            next = node.parentNode;
          }
        }
        node = next;
      } while (seekRange && endNotReached);
      if (haveStart) {
        range.setEndAfter(lastGood);
        const boxList = this.clientLayout.getRangeClientRects(range);
        for (let i = 0; i < boxList.length; i++) {
          arr.push(boxList[i]);
        }
        haveStart = false;
      }
    }
    return arr;
  }

  /**
   * Give block's initial and final nodes, find positions of the line bottoms.
   * This is, of course, somewhat hacky implementation.
   * @return position of line breaks
   */
  findLinePositions(checkPoints: vtree.NodeContext[]): number[] {
    const LOW_OVERLAP = 0.2;
    const MID_OVERLAP = 0.6;
    const positions = [];
    const boxes = this.getRangeBoxes(
        checkPoints[0].viewNode, checkPoints[checkPoints.length - 1].viewNode);
    boxes.sort(
        this.vertical ? vtree.clientrectDecreasingRight :
                        vtree.clientrectIncreasingTop);
    let lineBefore = 0;
    let lineAfter = 0;
    let lineEnd = 0;
    let lineLength = 0;
    let i = 0;
    const dir = this.getBoxDir();
    while (true) {
      if (i < boxes.length) {
        const box = boxes[i];
        let overlap = 1;
        if (lineLength > 0) {
          const boxSize = Math.max(this.getBoxSize(box), 1);
          if (dir * this.getBeforeEdge(box) < dir * lineBefore) {
            overlap = dir * (this.getAfterEdge(box) - lineBefore) / boxSize;
          } else if (dir * this.getAfterEdge(box) > dir * lineAfter) {
            overlap = dir * (lineAfter - this.getBeforeEdge(box)) / boxSize;
          } else {
            overlap = 1;
          }
        }
        if (lineLength == 0 || overlap >= MID_OVERLAP ||
            overlap >= LOW_OVERLAP && this.getStartEdge(box) >= lineEnd - 1) {
          lineEnd = this.getEndEdge(box);
          if (this.vertical) {
            lineBefore =
                lineLength == 0 ? box.right : Math.max(lineBefore, box.right);
            lineAfter =
                lineLength == 0 ? box.left : Math.min(lineAfter, box.left);
          } else {
            lineBefore =
                lineLength == 0 ? box.top : Math.min(lineBefore, box.top);
            lineAfter =
                lineLength == 0 ? box.bottom : Math.max(lineAfter, box.bottom);
          }
          lineLength++;
          i++;
          continue;
        }
      }

      // Add line
      if (lineLength > 0) {
        positions.push(lineAfter);
        lineLength = 0;
      }
      if (i >= boxes.length) {
        break;
      }
    }
    positions.sort(base.numberCompare);
    if (this.vertical) {
      positions.reverse();
    }
    return positions;
  }

  calculateClonedPaddingBorder(nodeContext: vtree.NodeContext): number {
    let clonedPaddingBorder = 0;
    nodeContext.walkUpBlocks((block) => {
      if (block.inheritedProps['box-decoration-break'] === 'clone') {
        asserts.assert(block.viewNode instanceof Element);
        const paddingBorders = this.getComputedPaddingBorder(block.viewNode);
        clonedPaddingBorder +=
            block.vertical ? -paddingBorders.left : paddingBorders.bottom;
        if (block.display === 'table') {
          clonedPaddingBorder += block.blockBorderSpacing;
        }
      }
    });
    return clonedPaddingBorder;
  }

  private getOffsetByRepetitiveElements(bp?: BreakPosition): number {
    let offset;
    if (bp) {
      offset = bp.calculateOffset(this);
    } else {
      offset = calculateOffset(
          null, repetitiveelements.collectElementsOffset(this));
    }
    return offset.current;
  }

  findBoxBreakPosition(bp: BoxBreakPosition, force: boolean):
      vtree.NodeContext {
    const self = this;
    const checkPoints = bp.checkPoints;
    let block = checkPoints[0];
    while (block.parent && block.inline) {
      block = block.parent;
    }
    let widows;
    let orphans;
    if (force) {
      // Last resort, ignore widows/orphans
      widows = 1;
      orphans = 1;
    } else {
      // Get widows/orphans settings from the block element
      widows = Math.max((block.inheritedProps['widows'] || 2) - 0, 1);
      orphans = Math.max((block.inheritedProps['orphans'] || 2) - 0, 1);
    }

    // In case of box-decoration-break: clone, width (or height in vertical
    // writing mode) of cloned paddings and borders should be taken into
    // account.
    const clonedPaddingBorder = self.calculateClonedPaddingBorder(block);

    // Select the first overflowing line break position
    const linePositions = this.findLinePositions(checkPoints);
    let edge = this.footnoteEdge - clonedPaddingBorder;
    const dir = this.getBoxDir();
    const repetitiveElementsOffset = this.getOffsetByRepetitiveElements(bp);
    edge -= dir * repetitiveElementsOffset;

    // If an "overflowing" checkpoint (e.g. not allowed by LayoutConstraint)
    // exists before the edge, a line containing the checkpoint should be
    // deferred to the next column.
    const firstOverflowing =
        this.findFirstOverflowingEdgeAndCheckPoint(checkPoints);
    if (isNaN(firstOverflowing.edge)) {
      firstOverflowing.edge = dir * Infinity;
    }
    let lineIndex = base.binarySearch(linePositions.length, (i) => {
      const p = linePositions[i];
      return self.vertical ? p < edge || p <= firstOverflowing.edge :
                             p > edge || p >= firstOverflowing.edge;
    });

    // If no break point is found due to the "overflowing" checkpoint,
    // give up deferring a line containing the checkpoint and try to cut the
    // line just before it.
    const forceCutBeforeOverflowing = lineIndex <= 0;
    if (forceCutBeforeOverflowing) {
      lineIndex = base.binarySearch(
          linePositions.length,
          (i) => self.vertical ? linePositions[i] < edge :
                                 linePositions[i] > edge);
    }

    // First edge after the one that both fits and satisfies widows constraint.
    lineIndex = Math.min(linePositions.length - widows, lineIndex);
    if (lineIndex < orphans) {
      // Not enough lines to satisfy orphans constraint, cannot break here.
      return null;
    }
    edge = linePositions[lineIndex - 1];
    let nodeContext;
    if (forceCutBeforeOverflowing) {
      nodeContext = firstOverflowing.checkPoint;
    } else {
      nodeContext = this.findAcceptableBreakInside(bp.checkPoints, edge, force);
    }
    if (nodeContext) {
      // When line-height is small, the edge calculated above (using Range)
      // can be larger than the edge of the block container containing the text.
      // We update the edge by measuring the block edge.
      const blockEdge = this.getAfterEdgeOfBlockContainer(nodeContext);
      if (!isNaN(blockEdge) && blockEdge < edge) {
        edge = blockEdge;
      }
      this.computedBlockSize =
          dir * (edge - this.beforeEdge) + repetitiveElementsOffset;
    }
    return nodeContext;
  }

  getAfterEdgeOfBlockContainer(nodeContext: vtree.NodeContext): number {
    let blockParent = nodeContext;
    do {
      blockParent = blockParent.parent;
    } while (blockParent && blockParent.inline);
    if (blockParent) {
      blockParent = blockParent.copy().modify();
      blockParent.after = true;
      return calculateEdge(blockParent, this.clientLayout, 0, this.vertical);
    } else {
      return NaN;
    }
  }

  findFirstOverflowingEdgeAndCheckPoint(checkPoints: vtree.NodeContext[]):
      {edge: number, checkPoint: vtree.NodeContext|null} {
    const index = checkPoints.findIndex((cp) => cp.overflow);
    if (index < 0) {
      return {edge: NaN, checkPoint: null};
    }
    const cp = checkPoints[index];
    return {
      edge: this.calculateEdge(null, checkPoints, index, cp.boxOffset),
      checkPoint: cp
    };
  }

  findEdgeBreakPosition(bp: EdgeBreakPosition): vtree.NodeContext {
    this.computedBlockSize =
        bp.computedBlockSize + this.getOffsetByRepetitiveElements(bp);
    return bp.position;
  }

  /**
   * Finalize a line break.
   * @return holing true
   */
  finishBreak(
      nodeContext: vtree.NodeContext, forceRemoveSelf: boolean,
      endOfColumn: boolean): task.Result<boolean> {
    asserts.assert(nodeContext.formattingContext);
    const layoutProcessor =
        (new LayoutProcessorResolver()).find(nodeContext.formattingContext);
    let result = layoutProcessor.finishBreak(
        this, nodeContext, forceRemoveSelf, endOfColumn);
    if (!result) {
      result = blockLayoutProcessor.finishBreak(
          this, nodeContext, forceRemoveSelf, endOfColumn);
    }
    return result;
  }

  findAcceptableBreakPosition(): BreakPositionAndNodeContext {
    let bp = null;
    let nodeContext = null;
    let penalty = 0;
    let nextPenalty = 0;
    do {
      penalty = nextPenalty;
      nextPenalty = Number.MAX_VALUE;
      for (let i = this.breakPositions.length - 1; i >= 0 && !nodeContext;
           --i) {
        bp = this.breakPositions[i];
        nodeContext = bp.findAcceptableBreak(this, penalty);
        const minPenalty = bp.getMinBreakPenalty();
        if (minPenalty > penalty) {
          nextPenalty = Math.min(nextPenalty, minPenalty);
        }
      }
    } while (
        // Don't need to find a non-optimal break position if
        // forceNonfitting=false
        nextPenalty > penalty && !nodeContext && this.forceNonfitting);
    return {breakPosition: nodeContext ? bp : null, nodeContext};
  }

  doFinishBreak(
      nodeContext: vtree.NodeContext, overflownNodeContext: vtree.NodeContext,
      initialNodeContext: vtree.NodeContext,
      initialComputedBlockSize: number): task.Result<vtree.NodeContext> {
    if (this.pageFloatLayoutContext.isInvalidated() || this.pageBreakType ||
        !overflownNodeContext) {
      return task.newResult(nodeContext);
    }
    const self = this;
    const frame: task.Frame<vtree.NodeContext> = task.newFrame('doFinishBreak');
    let forceRemoveSelf = false;
    if (!nodeContext) {
      // Last resort
      if (this.forceNonfitting) {
        logging.logger.warn('Could not find any page breaks?!!');
        self.skipTailEdges(overflownNodeContext).then((nodeContext) => {
          if (nodeContext) {
            nodeContext = nodeContext.modify();
            nodeContext.overflow = false;
            self.finishBreak(nodeContext, forceRemoveSelf, true).then(() => {
              frame.finish(nodeContext);
            });
          } else {
            frame.finish(nodeContext);
          }
        });
        return frame.result();
      } else {
        nodeContext = initialNodeContext;
        forceRemoveSelf = true;
        self.computedBlockSize = initialComputedBlockSize;
      }
    }
    this.finishBreak(nodeContext, forceRemoveSelf, true).then(() => {
      frame.finish(nodeContext);
    });
    return frame.result();
  }

  /**
   * Determines if a page break is acceptable at this position
   */
  isBreakable(flowPosition: vtree.NodeContext): boolean {
    if (flowPosition.after) {
      return true;
    }

    // may be an empty block
    switch (flowPosition.sourceNode.namespaceURI) {
      case base.NS.SVG:
        return false;
    }
    return !flowPosition.flexContainer;
  }

  /**
   * Determines if an indent value is zero
   */
  zeroIndent(val: string|number): boolean {
    const s = val.toString();
    return s == '' || s == 'auto' || !!s.match(/^0+(.0*)?[^0-9]/);
  }

  /**
   * @return true if overflows
   */
  checkOverflowAndSaveEdge(
      nodeContext: vtree.NodeContext,
      trailingEdgeContexts: vtree.NodeContext[]): boolean {
    if (!nodeContext) {
      return false;
    }
    if (isOrphan(nodeContext.viewNode)) {
      return false;
    }
    let edge = calculateEdge(nodeContext, this.clientLayout, 0, this.vertical);
    const offsets = calculateOffset(
        nodeContext,
        repetitiveelements.collectElementsOffset(this));
    const overflown =
        this.isOverflown(edge + (this.vertical ? -1 : 1) * offsets.minimum);
    if (this.isOverflown(edge + (this.vertical ? -1 : 1) * offsets.current) &&
        !this.nodeContextOverflowingDueToRepetitiveElements) {
      this.nodeContextOverflowingDueToRepetitiveElements = nodeContext;
    } else if (trailingEdgeContexts) {
      // If the edge does not overflow add the trailing margin, which is
      // truncated to the remaining fragmentainer extent.
      const marginEdge =
          edge + this.getTrailingMarginEdgeAdjustment(trailingEdgeContexts);
      const footnoteEdge =
          this.footnoteEdge - this.getBoxDir() * offsets.current;
      edge = this.vertical ?
          Math.min(edge, Math.max(marginEdge, footnoteEdge)) :
          Math.max(edge, Math.min(marginEdge, footnoteEdge));
    }
    this.updateMaxReachedAfterEdge(edge);
    return overflown;
  }

  /**
   * Save a possible page break position on a CSS block edge. Check if it
   * overflows.
   * @return true if overflows
   */
  checkOverflowAndSaveEdgeAndBreakPosition(
      nodeContext: vtree.NodeContext, trailingEdgeContexts: vtree.NodeContext[],
      saveEvenOverflown: boolean, breakAtTheEdge: string|null): boolean {
    if (!nodeContext) {
      return false;
    }
    if (isOrphan(nodeContext.viewNode)) {
      return false;
    }
    const overflown =
        this.checkOverflowAndSaveEdge(nodeContext, trailingEdgeContexts);
    if (saveEvenOverflown || !overflown) {
      this.saveEdgeBreakPosition(nodeContext, breakAtTheEdge, overflown);
    }
    return overflown;
  }

  applyClearance(nodeContext: vtree.NodeContext): boolean {
    if (!nodeContext.viewNode.parentNode) {
      // Cannot do ceralance for nodes without parents
      return false;
    }

    // measure where the edge of the element would be without clearance
    const margin = this.getComputedMargin((nodeContext.viewNode as Element));
    const spacer = nodeContext.viewNode.ownerDocument.createElement('div');
    if (this.vertical) {
      spacer.style.bottom = '0px';
      spacer.style.width = '1px';
      spacer.style.marginRight = `${margin.right}px`;
    } else {
      spacer.style.right = '0px';
      spacer.style.height = '1px';
      spacer.style.marginTop = `${margin.top}px`;
    }
    nodeContext.viewNode.parentNode.insertBefore(spacer, nodeContext.viewNode);
    let spacerBox = this.clientLayout.getElementClientRect(spacer);
    const edge = this.getBeforeEdge(spacerBox);
    const dir = this.getBoxDir();
    const clear = nodeContext.clearSide;
    let clearEdge = -this.getBoxDir() * Infinity;
    if (clear === 'all') {
      clearEdge =
          this.pageFloatLayoutContext.getPageFloatClearEdge(clear, this);
    }
    switch (clear) {
      case 'left':
        clearEdge = dir * Math.max(clearEdge * dir, this.leftFloatEdge * dir);
        break;
      case 'right':
        clearEdge = dir * Math.max(clearEdge * dir, this.rightFloatEdge * dir);
        break;
      default:
        clearEdge = dir *
            Math.max(
                clearEdge * dir,
                Math.max(this.rightFloatEdge * dir, this.leftFloatEdge * dir));
    }

    // edge holds the position where element border "before" edge will be
    // without clearance. clearEdge is the "after" edge of the float to clear.
    if (edge * dir >= clearEdge * dir) {
      // No need for clearance
      nodeContext.viewNode.parentNode.removeChild(spacer);
      return false;
    } else {
      // Need some clearance, determine how much. Add the clearance node,
      // measure its after edge and adjust after margin (required due to
      // possible margin collapse before clearance was introduced).
      const height = Math.max(1, (clearEdge - edge) * dir);
      if (this.vertical) {
        spacer.style.width = `${height}px`;
      } else {
        spacer.style.height = `${height}px`;
      }
      spacerBox = this.clientLayout.getElementClientRect(spacer);
      const afterEdge = this.getAfterEdge(spacerBox);
      if (this.vertical) {
        let wAdj = afterEdge + margin.right - clearEdge;
        if (wAdj > 0 == margin.right >= 0) {
          // In addition to collapsed portion
          wAdj += margin.right;
        }
        spacer.style.marginLeft = `${wAdj}px`;
      } else {
        let hAdj = clearEdge - (afterEdge + margin.top);
        if (hAdj > 0 == margin.top >= 0) {
          // In addition to collapsed portion
          hAdj += margin.top;
        }
        spacer.style.marginBottom = `${hAdj}px`;
      }
      nodeContext.clearSpacer = spacer;
      return true;
    }
  }

  isBFC(formattingContext: vtree.FormattingContext): boolean {
    if (formattingContext instanceof BlockFormattingContext) {
      return true;
    }
    if (formattingContext instanceof TableFormattingContext) {
      return false;
    }
    if (formattingContext instanceof
        repetitiveelements
            .RepetitiveElementsOwnerFormattingContext) {
      return true;
    }
    return false;
  }

  /**
   * Skips positions until either the start of unbreakable block or inline
   * content. Also sets breakBefore on the result combining break-before and
   * break-after properties from all elements that meet at the edge.
   */
  skipEdges(
      nodeContext: vtree.NodeContext, leadingEdge: boolean,
      forcedBreakValue: string|null): task.Result<vtree.NodeContext> {
    const fc = nodeContext.after ?
        nodeContext.parent && nodeContext.parent.formattingContext :
        nodeContext.formattingContext;
    if (fc && !this.isBFC(fc)) {
      return task.newResult(nodeContext);
    }
    const self = this;
    const frame: task.Frame<vtree.NodeContext> = task.newFrame('skipEdges');

    // If a forced break occurred at the end of the previous column,
    // nodeContext.after should be false.
    let atUnforcedBreak =
        !forcedBreakValue && leadingEdge && (nodeContext && nodeContext.after);
    let breakAtTheEdge = forcedBreakValue;
    let lastAfterNodeContext = null;
    let leadingEdgeContexts = [];
    let trailingEdgeContexts = [];
    let onStartEdges = false;

    function needForcedBreak() {
      // leadingEdge=true means that we are at the beginning of the new column
      // and hence must avoid a break (Otherwise leading to an infinite loop)
      return !!forcedBreakValue ||
          !leadingEdge && breaks.isForcedBreakValue(breakAtTheEdge);
    }

    function processForcedBreak() {
      nodeContext = leadingEdgeContexts[0] || nodeContext;
      nodeContext.viewNode.parentNode.removeChild(nodeContext.viewNode);
      self.pageBreakType = breakAtTheEdge;
    }
    frame
        .loopWithFrame((loopFrame) => {
          while (nodeContext) {
            asserts.assert(nodeContext.formattingContext);
            const layoutProcessor = (new LayoutProcessorResolver())
                                        .find(nodeContext.formattingContext);

            // A code block to be able to use break. Break moves to the next
            // node position.
            do {
              if (!nodeContext.viewNode) {
                // Non-displayable content, skip
                break;
              }
              if (nodeContext.inline && nodeContext.viewNode.nodeType != 1) {
                if (vtree.canIgnore(
                        nodeContext.viewNode, nodeContext.whitespace)) {
                  // Ignorable text content, skip
                  break;
                }
                if (!nodeContext.after) {
                  // Leading edge of non-empty block -> finished going through
                  // all starting edges of the box
                  if (needForcedBreak()) {
                    processForcedBreak();
                  } else if (self.checkOverflowAndSaveEdgeAndBreakPosition(
                          lastAfterNodeContext, null, true, breakAtTheEdge)) {
                    nodeContext = (self.stopAtOverflow ?
                                        lastAfterNodeContext || nodeContext :
                                        nodeContext)
                                      .modify();
                    nodeContext.overflow = true;
                  } else {
                    nodeContext = nodeContext.modify();
                    nodeContext.breakBefore = breakAtTheEdge;
                  }
                  loopFrame.breakLoop();
                  return;
                }
              }
              if (!nodeContext.after) {
                if (layoutProcessor) {
                  if (layoutProcessor.startNonInlineElementNode(nodeContext)) {
                    break;
                  }
                }
                if (nodeContext.clearSide) {
                  // clear
                  if (self.applyClearance(nodeContext) && leadingEdge &&
                      self.breakPositions.length === 0) {
                    self.saveEdgeBreakPosition(
                        nodeContext.copy(), breakAtTheEdge, false);
                  }
                }
                if (!self.isBFC(nodeContext.formattingContext) ||
                    nodeContext.formattingContext instanceof
                        repetitiveelements
                            .RepetitiveElementsOwnerFormattingContext ||
                    self.isFloatNodeContext(nodeContext) ||
                    nodeContext.flexContainer) {
                  // new formatting context, or float or flex container
                  // (unbreakable)
                  leadingEdgeContexts.push(nodeContext.copy());
                  breakAtTheEdge = breaks.resolveEffectiveBreakValue(
                      breakAtTheEdge, nodeContext.breakBefore);

                  // check if a forced break must occur before the block.
                  if (needForcedBreak()) {
                    processForcedBreak();
                  } else if (self.checkOverflowAndSaveEdgeAndBreakPosition(
                          lastAfterNodeContext, null, true, breakAtTheEdge) ||
                      !self.layoutConstraint.allowLayout(nodeContext)) {
                    // overflow
                    nodeContext = (self.stopAtOverflow ?
                                        lastAfterNodeContext || nodeContext :
                                        nodeContext)
                                      .modify();
                    nodeContext.overflow = true;
                  }
                  loopFrame.breakLoop();
                  return;
                }
              }
              if (nodeContext.viewNode.nodeType != 1) {
                // not an element
                break;
              }
              const style = (nodeContext.viewNode as HTMLElement).style;
              if (nodeContext.after) {
                // Skip an empty inline box at the start of a block
                // (An anonymous block consisting entirely of
                // collapsible white space is removed from the rendering tree)
                if (nodeContext.inline) {
                  break;
                }
                if (layoutProcessor) {
                  if (layoutProcessor.afterNonInlineElementNode(
                          nodeContext, self.stopAtOverflow)) {
                    break;
                  }
                }

                // Trailing edge
                if (onStartEdges) {
                  // finished going through all starting edges of the box.
                  // check if a forced break must occur before the block.
                  if (needForcedBreak()) {
                    processForcedBreak();
                    loopFrame.breakLoop();
                    return;
                  }

                  // since a break did not occur, move to the next edge. this
                  // edge is no longer the leading edge.
                  leadingEdgeContexts = [];
                  leadingEdge = false;
                  atUnforcedBreak = false;
                  breakAtTheEdge = null;
                }
                onStartEdges = false;

                // we are now on end edges.
                lastAfterNodeContext = nodeContext.copy();
                trailingEdgeContexts.push(lastAfterNodeContext);
                breakAtTheEdge = breaks.resolveEffectiveBreakValue(
                    breakAtTheEdge, nodeContext.breakAfter);
                if (style &&
                    !(self.zeroIndent(style.paddingBottom) &&
                      self.zeroIndent(style.borderBottomWidth))) {
                  // Non-zero trailing inset.
                  // Margins don't collapse across non-zero borders and
                  // paddings.
                  trailingEdgeContexts = [lastAfterNodeContext];
                }
              } else {
                // Leading edge
                leadingEdgeContexts.push(nodeContext.copy());
                breakAtTheEdge = breaks.resolveEffectiveBreakValue(
                    breakAtTheEdge, nodeContext.breakBefore);
                if (!self.layoutConstraint.allowLayout(nodeContext)) {
                  self.checkOverflowAndSaveEdgeAndBreakPosition(
                      lastAfterNodeContext, null, !self.stopAtOverflow,
                      breakAtTheEdge);
                  nodeContext = nodeContext.modify();
                  nodeContext.overflow = true;
                  if (self.stopAtOverflow) {
                    loopFrame.breakLoop();
                    return;
                  }
                }
                const viewTag = nodeContext.viewNode.localName;
                if (mediaTags[viewTag]) {
                  // elements that have inherent content
                  // check if a forced break must occur before the block.
                  if (needForcedBreak()) {
                    processForcedBreak();
                  } else if (self.checkOverflowAndSaveEdgeAndBreakPosition(
                          lastAfterNodeContext, null, true, breakAtTheEdge)) {
                    // overflow
                    nodeContext = (self.stopAtOverflow ?
                                        lastAfterNodeContext || nodeContext :
                                        nodeContext)
                                      .modify();
                    nodeContext.overflow = true;
                  }
                  loopFrame.breakLoop();
                  return;
                }
                if (style &&
                    !(self.zeroIndent(style.paddingTop) &&
                      self.zeroIndent(style.borderTopWidth))) {
                  // Non-zero leading inset
                  atUnforcedBreak = false;
                  trailingEdgeContexts = [];
                }
                onStartEdges = true;
              }
            } while (
                // we are now on starting edges.
                false);

            // End of block of code to use break
            const nextResult = self.nextInTree(nodeContext, atUnforcedBreak);
            if (nextResult.isPending()) {
              nextResult.then((nodeContextParam) => {
                nodeContext = nodeContextParam;
                loopFrame.continueLoop();
              });
              return;
            } else {
              nodeContext = nextResult.get();
            }
          }

          if (self.checkOverflowAndSaveEdgeAndBreakPosition(
                  lastAfterNodeContext, trailingEdgeContexts,
                  !self.stopAtOverflow, breakAtTheEdge)) {
            if (lastAfterNodeContext && self.stopAtOverflow) {
              nodeContext = lastAfterNodeContext.modify();
              nodeContext.overflow = true;
            } else {
              // TODO: what to return here??
            }
          } else if (breaks.isForcedBreakValue(breakAtTheEdge)) {
            self.pageBreakType = breakAtTheEdge;
          }
          loopFrame.breakLoop();
        })
        .then(() => {
          if (lastAfterNodeContext) {
            self.lastAfterPosition = lastAfterNodeContext.toNodePosition();
          }
          frame.finish(nodeContext);
        });
    return frame.result();
  }

  /**
   * Skips non-renderable positions until it hits the end of the flow or some
   * renderable content. Returns the nodeContext that was passed in if some
   * content remains and null if all content could be skipped.
   */
  skipTailEdges(nodeContext: vtree.NodeContext):
      task.Result<vtree.NodeContext> {
    let resultNodeContext = nodeContext.copy();
    const self = this;
    const frame: task.Frame<vtree.NodeContext> = task.newFrame('skipEdges');
    let breakAtTheEdge = null;
    let onStartEdges = false;
    frame
        .loopWithFrame((loopFrame) => {
          while (nodeContext) {
            // A code block to be able to use break. Break moves to the next
            // node position.
            do {
              if (!nodeContext.viewNode) {
                // Non-displayable content, skip
                break;
              }
              if (nodeContext.inline && nodeContext.viewNode.nodeType != 1) {
                if (vtree.canIgnore(
                        nodeContext.viewNode, nodeContext.whitespace)) {
                  // Ignorable text content, skip
                  break;
                }
                if (!nodeContext.after) {
                  // Leading edge of non-empty block -> finished going through
                  // all starting edges of the box
                  if (breaks.isForcedBreakValue(breakAtTheEdge)) {
                    self.pageBreakType = breakAtTheEdge;
                  }
                  loopFrame.breakLoop();
                  return;
                }
              }
              if (!nodeContext.after) {
                if (self.isFloatNodeContext(nodeContext) ||
                    nodeContext.flexContainer) {
                  // float or flex container (unbreakable)
                  breakAtTheEdge = breaks.resolveEffectiveBreakValue(
                      breakAtTheEdge, nodeContext.breakBefore);

                  // check if a forced break must occur before the block.
                  if (breaks.isForcedBreakValue(breakAtTheEdge)) {
                    self.pageBreakType = breakAtTheEdge;
                  }
                  loopFrame.breakLoop();
                  return;
                }
              }
              if (nodeContext.viewNode.nodeType != 1) {
                // not an element
                break;
              }
              const style = (nodeContext.viewNode as HTMLElement).style;
              if (nodeContext.after) {
                // Trailing edge
                if (onStartEdges) {
                  // finished going through all starting edges of the box.
                  // check if a forced break must occur before the block.
                  if (breaks.isForcedBreakValue(breakAtTheEdge)) {
                    self.pageBreakType = breakAtTheEdge;
                    loopFrame.breakLoop();
                    return;
                  }

                  // since a break did not occur, move to the next edge.
                  breakAtTheEdge = null;
                }
                onStartEdges = false;

                // we are now on end edges.
                breakAtTheEdge = breaks.resolveEffectiveBreakValue(
                    breakAtTheEdge, nodeContext.breakAfter);
              } else {
                // Leading edge
                breakAtTheEdge = breaks.resolveEffectiveBreakValue(
                    breakAtTheEdge, nodeContext.breakBefore);
                const viewTag = nodeContext.viewNode.localName;
                if (mediaTags[viewTag]) {
                  // elements that have inherent content
                  // check if a forced break must occur before the block.
                  if (breaks.isForcedBreakValue(breakAtTheEdge)) {
                    self.pageBreakType = breakAtTheEdge;
                  }
                  loopFrame.breakLoop();
                  return;
                }
                if (style &&
                    !(self.zeroIndent(style.paddingTop) &&
                      self.zeroIndent(style.borderTopWidth))) {
                  // Non-zero leading inset
                  loopFrame.breakLoop();
                  return;
                }
              }
              onStartEdges = true;
            } while (
                // we are now on starting edges.
                false);

            // End of block of code to use break
            const nextResult = self.layoutContext.nextInTree(nodeContext);
            if (nextResult.isPending()) {
              nextResult.then((nodeContextParam) => {
                nodeContext = nodeContextParam;
                loopFrame.continueLoop();
              });
              return;
            } else {
              nodeContext = nextResult.get();
            }
          }
          resultNodeContext = null;
          loopFrame.breakLoop();
        })
        .then(() => {
          frame.finish(resultNodeContext);
        });
    return frame.result();
  }

  layoutFloatOrFootnote(nodeContext: vtree.NodeContext):
      task.Result<vtree.NodeContext> {
    if (pagefloat.isPageFloat(nodeContext.floatReference) ||
        nodeContext.floatSide === 'footnote') {
      return this.layoutPageFloat(nodeContext);
    } else {
      return this.layoutFloat(nodeContext);
    }
  }

  /**
   * Layout next portion of the source.
   */
  layoutNext(
      nodeContext: vtree.NodeContext, leadingEdge: boolean,
      forcedBreakValue?: string|null): task.Result<vtree.NodeContext> {
    const self = this;
    const frame: task.Frame<vtree.NodeContext> = task.newFrame('layoutNext');
    this.skipEdges(nodeContext, leadingEdge, forcedBreakValue || null)
        .then((nodeContextParam) => {
          nodeContext = (nodeContextParam as vtree.NodeContext);
          if (!nodeContext || self.pageBreakType ||
              self.stopByOverflow(nodeContext)) {
            // finished all content, explicit page break or overflow (automatic
            // page break)
            frame.finish(nodeContext);
          } else {
            const formattingContext = nodeContext.formattingContext;
            asserts.assert(formattingContext);
            const layoutProcessor =
                (new LayoutProcessorResolver()).find(formattingContext);
            layoutProcessor.layout(nodeContext, self, leadingEdge)
                .thenFinish(frame);
          }
        });
    return frame.result();
  }

  clearOverflownViewNodes(nodeContext: vtree.NodeContext, removeSelf: boolean):
      void {
    if (!nodeContext) {
      return;
    }
    for (let parent = nodeContext.parent; nodeContext;
         nodeContext = parent, parent = parent ? parent.parent : null) {
      const formattingContext = (parent || nodeContext).formattingContext;
      asserts.assert(formattingContext);
      const layoutProcessor =
          (new LayoutProcessorResolver()).find(formattingContext);
      layoutProcessor.clearOverflownViewNodes(
          this, parent, nodeContext, removeSelf);
      removeSelf = false;
    }
  }

  initGeom(): void {
    // TODO: we should be able to avoid querying the layout engine at this
    // point. Create an element that fills the content area and query its size.
    // Calling getElementClientRect on the container element includes element
    // padding which is wrong for our purposes.
    const probe =
        (this.element.ownerDocument.createElement('div') as HTMLElement);
    probe.style.position = 'absolute';
    probe.style.top = `${this.paddingTop}px`;
    probe.style.right = `${this.paddingRight}px`;
    probe.style.bottom = `${this.paddingBottom}px`;
    probe.style.left = `${this.paddingLeft}px`;
    this.element.appendChild(probe);
    const columnBBox = this.clientLayout.getElementClientRect(probe);
    this.element.removeChild(probe);
    const offsetX = this.originX + this.left + this.getInsetLeft();
    const offsetY = this.originY + this.top + this.getInsetTop();
    this.box = new geom.Rect(
        offsetX, offsetY, offsetX + this.width, offsetY + this.height);
    this.startEdge =
        columnBBox ? this.vertical ? columnBBox.top : columnBBox.left : 0;
    this.endEdge =
        columnBBox ? this.vertical ? columnBBox.bottom : columnBBox.right : 0;
    this.beforeEdge =
        columnBBox ? this.vertical ? columnBBox.right : columnBBox.top : 0;
    this.afterEdge =
        columnBBox ? this.vertical ? columnBBox.left : columnBBox.bottom : 0;
    this.leftFloatEdge = this.beforeEdge;
    this.rightFloatEdge = this.beforeEdge;
    this.bottommostFloatTop = this.beforeEdge;
    this.footnoteEdge = this.afterEdge;
    this.bands = geom.shapesToBands(
        this.box, [this.getInnerShape()], this.getExclusions(), 8,
        this.snapHeight, this.vertical);
    this.createFloats();
  }

  init(): void {
    this.chunkPositions = [];
    base.setCSSProperty(this.element, 'width', `${this.width}px`);
    base.setCSSProperty(this.element, 'height', `${this.height}px`);
    this.initGeom();
    this.computedBlockSize = 0;
    this.overflown = false;
    this.pageBreakType = null;
    this.lastAfterPosition = null;
  }

  /**
   * Save the potential breaking position at the edge. Should, in general, save
   * "after" position but only after skipping all of the "before" ones and
   * getting to the non-empty content (to get breakAtEdge right).
   */
  saveEdgeBreakPosition(
      position: vtree.NodeContext, breakAtEdge: string|null,
      overflows: boolean): void {
    asserts.assert(position.formattingContext);
    const copy = position.copy();
    const layoutProcessor =
        (new LayoutProcessorResolver()).find(position.formattingContext);
    const clonedPaddingBorder = this.calculateClonedPaddingBorder(copy);
    const bp = layoutProcessor.createEdgeBreakPosition(
        copy, breakAtEdge, overflows,
        this.computedBlockSize + clonedPaddingBorder);
    this.breakPositions.push(bp);
  }

  /**
   * @param checkPoints array of breaking points for breakable block
   */
  saveBoxBreakPosition(checkPoints: vtree.NodeContext[]): void {
    const penalty = checkPoints[0].breakPenalty;
    const bp = new BoxBreakPosition(checkPoints, penalty);
    this.breakPositions.push(bp);
  }

  updateMaxReachedAfterEdge(afterEdge: number) {
    if (!isNaN(afterEdge)) {
      const size = this.getBoxDir() * (afterEdge - this.beforeEdge);
      this.computedBlockSize = Math.max(size, this.computedBlockSize);
    }
  }

  /**
   * @param chunkPosition starting position.
   * @return holding end position.
   */
  layout(
      chunkPosition: vtree.ChunkPosition, leadingEdge: boolean,
      breakAfter?: string|null): task.Result<vtree.ChunkPosition> {
    this.chunkPositions.push(chunkPosition);

    // So we can re-layout this column later
    if (chunkPosition.primary.after) {
      this.lastAfterPosition = chunkPosition.primary;
    }
    if (this.stopAtOverflow && this.overflown) {
      return task.newResult((chunkPosition as vtree.ChunkPosition));
    }
    if (this.isFullWithPageFloats()) {
      if (chunkPosition.primary.after &&
          chunkPosition.primary.steps.length === 1) {
        // End of contents
        return task.newResult((null as vtree.ChunkPosition));
      } else {
        return task.newResult((chunkPosition as vtree.ChunkPosition));
      }
    }
    const self = this;
    const frame: task.Frame<vtree.ChunkPosition> = task.newFrame('layout');

    // ------ start the column -----------
    self.openAllViews(chunkPosition.primary).then((nodeContext) => {
      let initialNodeContext = null;
      if (nodeContext.viewNode) {
        initialNodeContext = nodeContext.copy();
      } else {
        const nextInTreeListener = (evt) => {
          if (evt.nodeContext.viewNode) {
            initialNodeContext = evt.nodeContext;
            self.layoutContext.removeEventListener(
                'nextInTree', nextInTreeListener);
          }
        };
        self.layoutContext.addEventListener('nextInTree', nextInTreeListener);
      }
      const retryer = new LayoutRetryer(leadingEdge, breakAfter);
      retryer.layout(nodeContext, self).then((nodeContextParam) => {
        self.doFinishBreak(
                nodeContextParam, retryer.context.overflownNodeContext,
                initialNodeContext, retryer.initialComputedBlockSize)
            .then((positionAfter) => {
              let cont = null;
              if (!self.pseudoParent) {
                cont = self.doFinishBreakOfFragmentLayoutConstraints(
                    positionAfter);
              } else {
                cont = task.newResult(null);
              }
              cont.then(() => {
                if (self.pageFloatLayoutContext.isInvalidated()) {
                  frame.finish(null);
                  return;
                }
                if (!positionAfter) {
                  frame.finish(null);
                } else {
                  self.overflown = true;
                  const result =
                      new vtree.ChunkPosition(positionAfter.toNodePosition());
                  frame.finish(result);
                }
              });
            });
      });
    });
    return frame.result();
  }

  isFullWithPageFloats(): boolean {
    return this.pageFloatLayoutContext.isColumnFullWithPageFloats(this);
  }

  getMaxBlockSizeOfPageFloats(): number {
    return this.pageFloatLayoutContext.getMaxBlockSizeOfPageFloats();
  }

  doFinishBreakOfFragmentLayoutConstraints(nodeContext) {
    const frame: task.Frame<boolean> =
        task.newFrame('doFinishBreakOfFragmentLayoutConstraints');
    const sortedFragmentLayoutConstraints =
        [].concat(this.fragmentLayoutConstraints);
    sortedFragmentLayoutConstraints.sort(
        (a, b) => a.getPriorityOfFinishBreak() - b.getPriorityOfFinishBreak());
    let i = 0;
    frame
        .loop(() => {
          if (i < sortedFragmentLayoutConstraints.length) {
            const result = sortedFragmentLayoutConstraints[i++].finishBreak(
                nodeContext, this);
            return result.thenReturn(true);
          } else {
            return task.newResult(false);
          }
        })
        .then(() => {
          frame.finish(true);
        });
    return frame.result();
  }

  /**
   * @param nodeContext starting position.
   * @return holding end position.
   */
  doLayout(
      nodeContext: vtree.NodeContext, leadingEdge: boolean,
      breakAfter?: string|null): task.Result<{
    nodeContext: vtree.NodeContext,
    overflownNodeContext: vtree.NodeContext
  }> {
    const self = this;
    const frame: task.Frame<{
      nodeContext: vtree.NodeContext,
      overflownNodeContext: vtree.NodeContext
    }> = task.newFrame('doLayout');
    let overflownNodeContext: vtree.NodeContext = null;

    // ------ init backtracking list -----
    self.breakPositions = [];
    self.nodeContextOverflowingDueToRepetitiveElements = null;

    // ------- fill the column -------------
    frame
        .loopWithFrame((loopFrame) => {
          while (nodeContext) {
            // fill a single block
            let pending = true;
            self.layoutNext(nodeContext, leadingEdge, breakAfter || null)
                .then((nodeContextParam) => {
                  leadingEdge = false;
                  breakAfter = null;
                  if (self.nodeContextOverflowingDueToRepetitiveElements &&
                      self.stopAtOverflow) {
                    self.pageBreakType = null;
                    nodeContext =
                        self.nodeContextOverflowingDueToRepetitiveElements;
                    nodeContext.overflow = true;
                  } else {
                    nodeContext = nodeContextParam;
                  }
                  if (self.pageFloatLayoutContext.isInvalidated()) {
                    loopFrame.breakLoop();
                  } else if (self.pageBreakType) {
                    // explicit page break
                    loopFrame.breakLoop(); // Loop end
                  } else if (nodeContext && self.stopByOverflow(nodeContext)) {
                    // overflow (implicit page break): back up and find a
                    // page break
                    overflownNodeContext = nodeContext;
                    const bp = self.findAcceptableBreakPosition();
                    nodeContext = bp.nodeContext;
                    if (bp.breakPosition) {
                      bp.breakPosition.breakPositionChosen(self);
                    }
                    loopFrame.breakLoop(); // Loop end
                  } else {
                    if (pending) {
                      // Sync case
                      pending = false;
                    } else {
                      // Async case
                      loopFrame.continueLoop();
                    }
                  }
                });
            if (pending) {
              // Async case and loop end
              pending = false;
              return;
            }
          }

          // Sync case
          self.computedBlockSize += self.getOffsetByRepetitiveElements();
          loopFrame.breakLoop();
        })
        .then(() => {
          frame.finish({nodeContext, overflownNodeContext});
        });
    return frame.result();
  }

  /**
   * Re-layout already laid-out chunks. Return the position of the last flow if
   * there is an overflow.
   * TODO: deal with chunks that did not fit at all.
   * @return holding end position.
   */
  redoLayout(): task.Result<vtree.ChunkPosition> {
    const chunkPositions = this.chunkPositions;
    let last = this.element.lastChild;
    while (last != this.last) {
      const prev = last.previousSibling;
      if (!(this.element === last.parentNode &&
            this.layoutContext.isPseudoelement(last))) {
        this.element.removeChild(last);
      }
      last = prev;
    }
    this.killFloats();
    this.init();
    const self = this;
    const frame: task.Frame<vtree.ChunkPosition> = task.newFrame('redoLayout');
    let i = 0;
    let res = null;
    let leadingEdge = true;
    frame
        .loopWithFrame((loopFrame) => {
          if (i < chunkPositions.length) {
            const chunkPosition = chunkPositions[i++];
            self.layout(chunkPosition, leadingEdge).then((pos) => {
              leadingEdge = false;
              if (pos) {
                res = pos;
                loopFrame.breakLoop();
              } else {
                loopFrame.continueLoop();
              }
            });
            return;
          }
          loopFrame.breakLoop();
        })
        .then(() => {
          frame.finish(res);
        });
    return frame.result();
  }

  saveDistanceToBlockEndFloats() {
    const blockStartEdgeOfBlockEndFloats =
        this.pageFloatLayoutContext.getBlockStartEdgeOfBlockEndFloats();
    if (blockStartEdgeOfBlockEndFloats > 0 &&
        isFinite(blockStartEdgeOfBlockEndFloats)) {
      this.blockDistanceToBlockEndFloats = this.getBoxDir() *
          (blockStartEdgeOfBlockEndFloats - this.beforeEdge -
           this.computedBlockSize);
    }
  }
}

export const removeFollowingSiblings =
    (parentNode: Node, viewNode: Node): void => {
      if (!parentNode) {
        return;
      }
      let lastChild: Node;
      while ((lastChild = parentNode.lastChild) != viewNode) {
        parentNode.removeChild(lastChild);
      }
    };

export const firstCharPattern =
    /^[^A-Za-z0-9_\u009E\u009F\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02AF\u037B-\u037D\u0386\u0388-\u0482\u048A-\u0527]*([A-Za-z0-9_\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02AF\u037B-\u037D\u0386\u0388-\u0482\u048A-\u0527][^A-Za-z0-9_\u009E\u009F\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02AF\u037B-\u037D\u0386\u0388-\u0482\u048A-\u0527]*)?/;
type SinglePageFloatLayoutResult = {
  floatArea: PageFloatArea|null,
  pageFloatFragment: pagefloat.PageFloatFragment|null,
  newPosition: vtree.ChunkPosition|null
};

export {SinglePageFloatLayoutResult};

export const fixJustificationOnHyphen =
    (nodeContext: vtree.NodeContext, insertAfter: boolean, node: Node,
     insertionPoint: Node) => {
      if (base.checkSoftWrapOpportunityAfterHyphenBug(document.body)) {
        const hyphenChar = resolveHyphenateCharacter(nodeContext);
        const prevSibling = insertAfter ? node : node.previousSibling;
        const prevText = prevSibling ? prevSibling.textContent : '';
        if (prevText.charAt(prevText.length - 1) === hyphenChar) {
          const doc = node.ownerDocument;
          const parent = node.parentNode;
          if (base.checkSoftWrapOpportunityByWbrBug(document.body)) {
            // For IE
            parent.insertBefore(doc.createTextNode(' '), insertionPoint);
          } else {
            // For Edge
            parent.insertBefore(doc.createElement('wbr'), insertionPoint);
          }
        }
      }
    };

/**
 * breaking point resolver for Text Node.
 */
export class TextNodeBreaker {
  breakTextNode(
      textNode: Text, nodeContext: vtree.NodeContext, low: number,
      checkPoints: vtree.NodeContext[], checkpointIndex: number,
      force: boolean): vtree.NodeContext {
    if (nodeContext.after) {
      nodeContext.offsetInNode = textNode.length;
    } else {
      // Character with index low is the last one that fits.
      let viewIndex = low - nodeContext.boxOffset;
      const text = textNode.data;
      if (text.charCodeAt(viewIndex) == 173) {
        viewIndex =
            this.breakAfterSoftHyphen(textNode, text, viewIndex, nodeContext);
      } else {
        viewIndex = this.breakAfterOtherCharacter(
            textNode, text, viewIndex, nodeContext);
      }
      if (viewIndex > 0) {
        nodeContext = this.updateNodeContext(nodeContext, viewIndex, textNode);
      }
    }
    return nodeContext;
  }

  breakAfterSoftHyphen(
      textNode: Text, text: string, viewIndex: number,
      nodeContext: vtree.NodeContext): number {
    // convert trailing soft hyphen to a real hyphen
    textNode.replaceData(
        viewIndex, text.length - viewIndex,
        !nodeContext.breakWord ? resolveHyphenateCharacter(nodeContext) : '');
    return viewIndex + 1;
  }

  breakAfterOtherCharacter(
      textNode: Text, text: string, viewIndex: number,
      nodeContext: vtree.NodeContext): number {
    // keep the trailing character (it may be a space or not)
    const ch0 = text.charAt(viewIndex);
    viewIndex++;
    const ch1 = text.charAt(viewIndex);

    // If automatic hyphen was inserted here, add a real hyphen.
    textNode.replaceData(
        viewIndex, text.length - viewIndex,
        !nodeContext.breakWord && base.isLetter(ch0) && base.isLetter(ch1) ?
            resolveHyphenateCharacter(nodeContext) :
            '');
    return viewIndex;
  }

  updateNodeContext(
      nodeContext: vtree.NodeContext, viewIndex: number,
      textNode: Text): vtree.NodeContext {
    nodeContext = nodeContext.modify();
    nodeContext.offsetInNode += viewIndex;
    nodeContext.breakBefore = null;
    return nodeContext;
  }
}
TextNodeBreaker.instance = new TextNodeBreaker();

export const resolveHyphenateCharacter =
    (nodeContext: vtree.NodeContext): string =>
        nodeContext.hyphenateCharacter ||
    nodeContext.parent && nodeContext.parent.hyphenateCharacter || '-';

export const isSpecial = (e: Element): boolean =>
    !!e.getAttribute(vtree.SPECIAL_ATTR);

export const isSpecialNodeContext =
    (nodeContext: vtree.NodeContext): boolean => {
      if (!nodeContext) {
        return false;
      }
      const viewNode = nodeContext.viewNode;
      if (viewNode && viewNode.nodeType === 1) {
        return isSpecial((viewNode as Element));
      } else {
        return false;
      }
    };

export const isOrphan = (node: Node): boolean => {
  while (node) {
    if (node.parentNode === node.ownerDocument) {
      return false;
    }
    node = node.parentNode;
  }
  return true;
};

export class LayoutRetryer extends
    layoututil.AbstractLayoutRetryer {
  breakAfter: any;
  private initialPageBreakType: string|null = null;
  private initialComputedBlockSize: number = 0;
  private initialOverflown: boolean = false;
  context:
      {overflownNodeContext: vtree.NodeContext} = {overflownNodeContext: null};

  constructor(public readonly leadingEdge: boolean, breakAfter?: string|null) {
    super();
    this.breakAfter = breakAfter || null;
  }

  /**
   * @override
   */
  resolveLayoutMode(nodeContext) {
    return new DefaultLayoutMode(
        this.leadingEdge, this.breakAfter, this.context);
  }

  /**
   * @override
   */
  prepareLayout(nodeContext, column) {
    column.fragmentLayoutConstraints = [];
    if (!column.pseudoParent) {
      repetitiveelements.clearCache();
    }
  }

  /**
   * @override
   */
  clearNodes(initialPosition) {
    super.clearNodes(initialPosition);
    let nodeContext = initialPosition;
    while (nodeContext) {
      const viewNode = nodeContext.viewNode;
      if (viewNode) {
        removeFollowingSiblings(viewNode.parentNode, viewNode);
      }
      nodeContext = nodeContext.parent;
    }
  }

  /**
   * @override
   */
  saveState(nodeContext, column) {
    super.saveState(nodeContext, column);
    this.initialPageBreakType = column.pageBreakType;
    this.initialComputedBlockSize = column.computedBlockSize;
    this.initialOverflown = column.overflown;
  }

  /**
   * @override
   */
  restoreState(nodeContext, column) {
    super.restoreState(nodeContext, column);
    column.pageBreakType = this.initialPageBreakType;
    column.computedBlockSize = this.initialComputedBlockSize;
    column.overflown = this.initialOverflown;
  }
}

export class DefaultLayoutMode implements layoututil.LayoutMode {
  constructor(
      public readonly leadingEdge: boolean,
      public readonly breakAfter: string|null,
      public readonly context: {overflownNodeContext: vtree.NodeContext}) {}

  /**
   * @override
   */
  doLayout(nodeContext, column) {
    const frame: task.Frame<vtree.NodeContext> =
        task.newFrame('DefaultLayoutMode.doLayout');
    selectors
        .processAfterIfContinuesOfAncestors(nodeContext, column)
        .then(() => {
          column.doLayout(nodeContext, this.leadingEdge, this.breakAfter)
              .then((result) => {
                this.context.overflownNodeContext = result.overflownNodeContext;
                frame.finish(result.nodeContext);
              });
        });
    return frame.result();
  }

  /**
   * @override
   */
  accept(nodeContext, column) {
    if (column.pageFloatLayoutContext.isInvalidated() || column.pageBreakType) {
      return true;
    }
    if (column.fragmentLayoutConstraints.length <= 0) {
      return true;
    }
    return column.fragmentLayoutConstraints.every(
        (constraint) => constraint.allowLayout(
            nodeContext, this.context.overflownNodeContext, column));
  }

  /**
   * @override
   */
  postLayout(positionAfter, initialPosition, column, accepted) {
    if (!accepted) {
      const hasNextCandidate = column.fragmentLayoutConstraints.some(
          (constraint) => constraint.nextCandidate(positionAfter));

      // If there is no next candidate, we accept the current layout trial.
      // Later Column#doFinishBreak decides whether the overflowing content
      // should be placed as is or be deferred to the next column,
      // depending on the value of Column#forceNonfitting.
      accepted = !hasNextCandidate;
    }
    column.fragmentLayoutConstraints.forEach((constraint) => {
      constraint.postLayout(accepted, positionAfter, initialPosition, column);
    });
    return accepted;
  }
}

export class BlockLayoutProcessor implements LayoutProcessor {
  /**
   * @override
   */
  layout(nodeContext, column, leadingEdge) {
    if (column.isFloatNodeContext(nodeContext)) {
      return column.layoutFloatOrFootnote(nodeContext);
    } else if (column.isBreakable(nodeContext)) {
      return column.layoutBreakableBlock(nodeContext);
    } else {
      return column.layoutUnbreakable(nodeContext);
    }
  }

  /**
   * @override
   */
  createEdgeBreakPosition(position, breakOnEdge, overflows, columnBlockSize) {return new EdgeBreakPosition(
      position.copy(), breakOnEdge, overflows, columnBlockSize);}

  /**
   * @override
   */
  startNonInlineElementNode(nodeContext) {return false;}

  /**
   * @override
   */
  afterNonInlineElementNode(nodeContext) {return false;}

  /**
   * @override
   */
  clearOverflownViewNodes(column, parentNodeContext, nodeContext, removeSelf) {
    if (!nodeContext.viewNode) {
      return;
    }
    if (!nodeContext.viewNode.parentNode) {
      return;
    }
    const parentNode = nodeContext.viewNode.parentNode;
    removeFollowingSiblings(parentNode, nodeContext.viewNode);
    if (removeSelf) {
      parentNode.removeChild(nodeContext.viewNode);
    }
  }

  /**
   * @return holing true
   * @override
   */
  finishBreak(
      column: Column, nodeContext: vtree.NodeContext, forceRemoveSelf: boolean,
      endOfColumn: boolean): task.Result<boolean> {
    const removeSelf = forceRemoveSelf ||
        nodeContext.viewNode != null && nodeContext.viewNode.nodeType == 1 &&
            !nodeContext.after;
    column.clearOverflownViewNodes(nodeContext, removeSelf);
    if (endOfColumn) {
      column.fixJustificationIfNeeded(nodeContext, true);
      column.layoutContext.processFragmentedBlockEdge(
          removeSelf ? nodeContext : nodeContext.parent);
    }
    return task.newResult(true);
  }
}

export const blockLayoutProcessor = new BlockLayoutProcessor();
plugin.registerHook(
    plugin.HOOKS.RESOLVE_FORMATTING_CONTEXT,
    (nodeContext, firstTime, display, position, floatSide, isRoot) => {
      const parent = nodeContext.parent;
      if (!parent && nodeContext.formattingContext) {
        return null;
      } else if (parent &&
          nodeContext.formattingContext !== parent.formattingContext) {
        return null;
      } else if (nodeContext.establishesBFC ||
          !nodeContext.formattingContext &&
              isBlock(
                  display, position, floatSide, isRoot)) {
        return new BlockFormattingContext(
            parent ? parent.formattingContext : null);
      } else {
        return null;
      }
    });
plugin.registerHook(
    plugin.HOOKS.RESOLVE_LAYOUT_PROCESSOR, (formattingContext) => {
      if (formattingContext instanceof BlockFormattingContext) {
        return blockLayoutProcessor;
      }
      return null;
    });

export class PageFloatArea extends Column {
  private rootViewNodes: Element[] = [];
  private floatMargins: geom.Insets[] = [];
  adjustContentRelativeSize: boolean = true;

  constructor(
      public readonly floatSide: string, element: Element,
      layoutContext: vtree.LayoutContext, clientLayout: vtree.ClientLayout,
      layoutConstraint: LayoutConstraint,
      pageFloatLayoutContext: pagefloat.PageFloatLayoutContext,
      public readonly parentContainer: vtree.Container) {
    super(
        element, layoutContext, clientLayout, layoutConstraint,
        pageFloatLayoutContext);
  }

  /**
   * @override
   */
  openAllViews(position) {
    return super.openAllViews(position)
        .thenAsync((nodeContext) => {
          if (nodeContext) {
            this.fixFloatSizeAndPosition(nodeContext);
          }
          return task.newResult(nodeContext);
        });
  }

  convertPercentageSizesToPx(target: Element) {
    const containingBlockRect = this.parentContainer.getPaddingRect();
    const refWidth = containingBlockRect.x2 - containingBlockRect.x1;
    const refHeight = containingBlockRect.y2 - containingBlockRect.y1;

    function convertPercentageToPx(props: string[], refValue: number) {
      props.forEach((propName) => {
        const valueString = base.getCSSProperty(target, propName);
        if (valueString && valueString.charAt(valueString.length - 1) === '%') {
          const percentageValue = parseFloat(valueString);
          const value = refValue * percentageValue / 100;
          base.setCSSProperty(target, propName, `${value}px`);
        }
      });
    }
    convertPercentageToPx(['width', 'max-width', 'min-width'], refWidth);
    convertPercentageToPx(['height', 'max-height', 'min-height'], refHeight);
    convertPercentageToPx(
        [
          'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
          'padding-top', 'padding-right', 'padding-bottom', 'padding-left'
        ],
        this.vertical ? refHeight : refWidth);
    ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'].forEach(
        (propName) => {
          const value = base.getCSSProperty(target, propName);
          if (value === 'auto') {
            base.setCSSProperty(target, propName, '0');
          }
        });
  }

  fixFloatSizeAndPosition(nodeContext: vtree.NodeContext) {
    while (nodeContext.parent) {
      nodeContext = nodeContext.parent;
    }
    asserts.assert(nodeContext.viewNode.nodeType === 1);
    const rootViewNode = (nodeContext.viewNode as Element);
    this.rootViewNodes.push(rootViewNode);
    if (this.adjustContentRelativeSize) {
      this.convertPercentageSizesToPx(rootViewNode);
    }
    this.floatMargins.push(this.getComputedMargin(rootViewNode));
    if (this.adjustContentRelativeSize) {
      const floatSide = this.floatSide;
      const isVertical = this.parentContainer.vertical;
      if (isVertical) {
        if (floatSide === 'block-end' || floatSide === 'left') {
          const height = base.getCSSProperty(rootViewNode, 'height');
          if (height !== '' && height !== 'auto') {
            base.setCSSProperty(rootViewNode, 'margin-top', 'auto');
          }
        }
      } else {
        if (floatSide === 'block-end' || floatSide === 'bottom') {
          const width = base.getCSSProperty(rootViewNode, 'width');
          if (width !== '' && width !== 'auto') {
            base.setCSSProperty(rootViewNode, 'margin-left', 'auto');
          }
        }
      }
    }
  }

  getContentInlineSize(): number {
    return Math.max.apply(null, this.rootViewNodes.map(function(r, i) {
      const box = this.clientLayout.getElementClientRect(r);
      const margin = this.floatMargins[i];
      return this.vertical ? margin.top + box.height + margin.bottom :
                             margin.left + box.width + margin.right;
    }, this));
  }
}

export const getElementHeight =
    (element: Element, column: Column, vertical: boolean): number => {
      const rect = column.clientLayout.getElementClientRect(element);
      const margin = column.getComputedMargin(element);
      return vertical ? rect['width'] + margin['left'] + margin['right'] :
                        rect['height'] + margin['top'] + margin['bottom'];
    };
