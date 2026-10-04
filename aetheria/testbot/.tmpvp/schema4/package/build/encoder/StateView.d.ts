import { ChangeTree, IndexedOperations, Ref } from "./ChangeTree.js";
export declare function createView(iterable?: boolean): StateView;
export declare class StateView {
    iterable: boolean;
    /**
     * Iterable list of items that are visible to this view
     * (Available only if constructed with `iterable: true`)
     */
    items: Ref[];
    /**
     * List of ChangeTree's that are visible to this view
     */
    visible: WeakSet<ChangeTree>;
    /**
     * List of ChangeTree's that are invisible to this view
     */
    invisible: WeakSet<ChangeTree>;
    tags?: WeakMap<ChangeTree, number>;
    /**
     * Manual "ADD" operations for changes per ChangeTree, specific to this view.
     * (This is used to force encoding a property, even if it was not changed)
     */
    changes: Map<number, IndexedOperations>;
    /**
     * Set when an operation may have left `changes` out of topological
     * order (a parent that needs to be encoded before its descendants is
     * positioned after them in the Map). `Encoder.encodeView` consults
     * this flag and only runs the topo-ordering pass when it's true,
     * skipping the work in the common case where insertion order already
     * coincides with topo order.
     *
     * Only `remove()` can break the invariant: it writes entries that
     * bypass `addParentOf`'s deepest-ancestor-first ordering. Everything
     * else (including multi-parent re-adds) preserves order by
     * construction. Reset to false at the end of each encodeView pass
     * (when `changes` is cleared).
     */
    changesOutOfOrder: boolean;
    constructor(iterable?: boolean);
    /**
     * Get the IndexedOperations entry for `refId`, creating one if missing.
     *
     * Map insertion order alone doesn't guarantee parent-before-child
     * iteration in all cases (a `view.remove()` followed by `view.add()`
     * can put a child entry into the Map before its newly-visible
     * ancestor). The wire-order invariant (parent SWITCH_TO_STRUCTURE
     * before any of its children's) is enforced at encode time by
     * `Encoder.encodeView` via a topological pass over `view.changes`.
     */
    protected touchChanges(refId: number): IndexedOperations;
    add(obj: Ref, tag?: number, checkIncludeParent?: boolean): boolean;
    protected addParentOf(childChangeTree: ChangeTree, tag: number): void;
    remove(obj: Ref, tag?: number): this;
    remove(obj: Ref, tag?: number, _isClear?: boolean): this;
    has(obj: Ref): boolean;
    hasTag(ob: Ref, tag?: number): boolean;
    clear(): void;
    isChangeTreeVisible(changeTree: ChangeTree): boolean;
    protected _recursiveDeleteVisibleChangeTree(changeTree: ChangeTree): void;
}
