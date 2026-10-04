import type { Schema } from "../Schema.js";
import { TypeContext } from "../types/TypeContext.js";
import type { Iterator } from "../encoding/decode.js";
import { Root } from "./Root.js";
import type { StateView } from "./StateView.js";
import type { ChangeSetName } from "./ChangeTree.js";
export declare class Encoder<T extends Schema = any> {
    static BUFFER_SIZE: number;
    sharedBuffer: Uint8Array;
    context: TypeContext;
    state: T;
    root: Root;
    constructor(state: T);
    protected setState(state: T): void;
    encode(it?: Iterator, view?: StateView, buffer?: Uint8Array, changeSetName?: ChangeSetName, isEncodeAll?: boolean, initialOffset?: number): Uint8Array;
    encodeAll(it?: Iterator, buffer?: Uint8Array): Uint8Array<ArrayBufferLike>;
    encodeAllView(view: StateView, sharedOffset: number, it: Iterator, bytes?: Uint8Array): Uint8Array<ArrayBufferLike>;
    /** Grow `buffer` to keep BUFFER_SIZE free bytes past `offset`, preserving `[0, offset)`. */
    protected ensureCapacity(buffer: Uint8Array, offset: number): Uint8Array;
    encodeView(view: StateView, sharedOffset: number, it: Iterator, bytes?: Uint8Array): Uint8Array<ArrayBufferLike>;
    /**
     * Produce a topological ordering of `view.changes` keys so each refId
     * is preceded by any ancestor that's also in the same view's changeset.
     *
     * The wire stream uses SWITCH_TO_STRUCTURE pointers; if a child is
     * encoded before any earlier op has introduced its refId on the
     * decoder, decode fails with "refId not found". An entry's refId can
     * only be introduced by an ADD on one of its ancestors — so any
     * ancestor that itself appears in this view's pending changes must
     * be encoded first.
     *
     * Implementation: DFS post-order over the parent chain. The `visited`
     * Set guards against duplicates; cycles are not expected in a
     * well-formed parent chain but the visited check is a cheap safety
     * net. Cost is O(n × d) for n entries with parent-chain depth d.
     */
    protected topoOrderViewChanges(view: StateView): number[];
    discardChanges(): void;
    tryEncodeTypeId(bytes: Uint8Array, baseType: typeof Schema, targetType: typeof Schema, it: Iterator): void;
    get hasChanges(): boolean;
}
