pragma circom 2.1.6;

// ---------------------------------------------------------------------------
// D2 — UPDATE_MODEL honesty proof (aggregator side).
// Proves that A computed the federated mean honestly, so B/C can trust x_new
// without recomputing it (the symmetric, role-swapped half of D2).
//
// Relation R_agg (design doc §D2), generalized to N trainers and written with
// the §3.1.5 "division-with-remainder" rewrite so it stays in integers (a
// finite field has no integer division):
//   (updates[N], x_new, remainder ; -) :
//       sum(updates) == N * x_new + remainder
//       0 <= remainder < N
//   =>  x_new     == floor( sum(updates) / N )
//       remainder == sum(updates) mod N
//
// For N = 2 this is exactly the doc's  2 * x_new = x' + x''  (remainder in {0,1}).
// All signals are public — A holds no secret here; B and C are the verifiers.
// nBits bounds each value so the sum cannot wrap the field (sound floor-div).
// ---------------------------------------------------------------------------

include "comparators.circom";
include "bitify.circom";

template UpdateModel(N, nBits) {
    signal input updates[N];   // x', x'', ... (the gradients A aggregated)
    signal input x_new;        // floor(sum / N), broadcast as next round's x
    signal input remainder;    // sum - N * x_new

    // Each update is a bounded non-negative integer (keeps floor-division sound).
    component ub[N];
    signal acc[N + 1];
    acc[0] <== 0;
    for (var i = 0; i < N; i++) {
        ub[i] = Num2Bits(nBits);
        ub[i].in <== updates[i];
        acc[i + 1] <== acc[i] + updates[i];
    }

    // (1) Euclidean relation:  sum == N * x_new + remainder
    acc[N] === N * x_new + remainder;

    // (2) 0 <= remainder < N
    component rb = Num2Bits(nBits);
    rb.in <== remainder;
    component lt = LessThan(nBits);
    lt.in[0] <== remainder;
    lt.in[1] <== N;
    lt.out === 1;

    // (3) quotient bounded (no field wrap on x_new)
    component xb = Num2Bits(nBits);
    xb.in <== x_new;
}

// Stage-1: N = 2 trainers (B, C), 64-bit value window.
component main { public [updates, x_new, remainder] } = UpdateModel(2, 64);
