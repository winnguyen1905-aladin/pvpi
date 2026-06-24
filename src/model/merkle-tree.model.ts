import { sha256hex } from "../utils/crypto.ts";
import type { ProofStep } from "../types/verify.ts";
import type { MerkleLeaf } from "./merkle-leaf.model.ts";

// Domain-separated Merkle tree over the leaves' leaf_hash values. A lone (odd)
// node is promoted unchanged rather than duplicated (avoids CVE-2012-2459).
export class MerkleTree {
  readonly leaves: MerkleLeaf[];
  readonly layers: string[][];

  constructor(leaves: MerkleLeaf[]) {
    if (leaves.length === 0) {
      throw new Error("MerkleTree requires at least one leaf");
    }
    this.leaves = [...leaves];
    this.layers = [this.leaves.map((l) => l.leaf_hash)];

    let current = this.layers[0];
    while (current.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          next.push(MerkleTree.hashInternal(current[i], current[i + 1]));
        } else {
          next.push(current[i]);
        }
      }
      this.layers.push(next);
      current = next;
    }
  }

  private static hashInternal(left: string, right: string): string {
    return sha256hex(
      Buffer.concat([Buffer.from("01", "hex"), Buffer.from(left, "hex"), Buffer.from(right, "hex")]),
    );
  }

  get root(): string {
    return this.layers[this.layers.length - 1][0];
  }

  proof(index: number): ProofStep[] {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error("proof: leaf index out of range");
    }
    const steps: ProofStep[] = [];
    let idx = index;
    for (let level = 0; level < this.layers.length - 1; level++) {
      const layer = this.layers[level];
      const isRightChild = idx % 2 === 1;
      const siblingIdx = isRightChild ? idx - 1 : idx + 1;
      if (siblingIdx < layer.length) {
        steps.push({ sibling: layer[siblingIdx], position: isRightChild ? "left" : "right" });
      }
      idx = Math.floor(idx / 2);
    }
    return steps;
  }

  // Stateless inclusion check from a bare leaf_hash + proof + anchored root.
  static verifyProof(leafHash: string, steps: ProofStep[], root: string): boolean {
    let h = leafHash;
    for (const step of steps) {
      h =
        step.position === "left"
          ? MerkleTree.hashInternal(step.sibling, h)
          : MerkleTree.hashInternal(h, step.sibling);
    }
    return h === root;
  }
}
