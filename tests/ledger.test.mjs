import test from "node:test";
import assert from "node:assert/strict";
import {
  computeEvenSplit,
  validateCustomSplit,
  createExpenseEntry,
  createSettlementEntry,
  calculateBalances,
  getEntryImpactForUser,
  getAllTags,
  normalizeTags,
  upsertEntry,
  deleteEntry,
  createEmptyLedger,
} from "../js/ledger.js";

const USERS = ["partnerA", "partnerB"];

test("computeEvenSplit preserves exact minor units for odd amounts", () => {
  const split = computeEvenSplit(10.01, "SGD", "partnerA", USERS);
  assert.equal(split.partnerA, 5.01);
  assert.equal(split.partnerB, 5.0);
  assert.equal(Number((split.partnerA + split.partnerB).toFixed(2)), 10.01);

  const jpySplit = computeEvenSplit(1001, "JPY", "partnerB", USERS);
  assert.equal(jpySplit.partnerB, 501);
  assert.equal(jpySplit.partnerA, 500);
});

test("validateCustomSplit rejects mismatched totals and accepts exact sums", () => {
  const ok = validateCustomSplit(50, "SGD", { partnerA: 12.5, partnerB: 37.5 }, USERS);
  assert.deepEqual(ok, { partnerA: 12.5, partnerB: 37.5 });

  assert.throws(
    () => validateCustomSplit(50, "SGD", { partnerA: 20, partnerB: 20 }, USERS),
    /must equal the total/
  );
});

test("calculateBalances handles multi-currency expenses, custom splits, and payback settlements", () => {
  // 1. Partner A pays 4800 JPY (~42.24 SGD) split evenly => B owes A 2400 JPY / 21.12 SGD
  const exp1 = createExpenseEntry(
    {
      title: "Ramen",
      date: "2026-11-25",
      amount: 4800,
      currency: "JPY",
      fxRate: 0.0088,
      paidBy: "partnerA",
      splitMode: "even",
    },
    USERS,
    "SGD"
  );

  // 2. Partner B pays 30 SGD custom split (A: 20, B: 10) => A owes B 20 SGD
  const exp2 = createExpenseEntry(
    {
      title: "Souvenirs",
      date: "2026-11-25",
      amount: 30,
      currency: "SGD",
      fxRate: 1,
      paidBy: "partnerB",
      splitMode: "sum",
      splits: { partnerA: 20, partnerB: 10 },
    },
    USERS,
    "SGD"
  );

  const mid = calculateBalances([exp1, exp2], USERS, "SGD");
  assert.equal(mid.isSettled, false);
  assert.equal(mid.debtorId, "partnerB");
  assert.equal(mid.creditorId, "partnerA");
  assert.equal(mid.owedAmountHome, 1.12); // 21.12 - 20.00
  assert.equal(mid.totalSpentHome, 72.24);
  assert.equal(mid.byCurrency.length, 2);

  const sgdRow = mid.byCurrency.find((c) => c.currency === "SGD");
  const jpyRow = mid.byCurrency.find((c) => c.currency === "JPY");
  assert.equal(sgdRow.debtorId, "partnerA");
  assert.equal(sgdRow.owedAmount, 20);
  assert.equal(jpyRow.debtorId, "partnerB");
  assert.equal(jpyRow.owedAmount, 2400);

  // 3. Partner B pays back 1.12 SGD to settle home currency balance
  const pay1 = createSettlementEntry(
    {
      title: "PayNow",
      date: "2026-11-25",
      amount: 1.12,
      currency: "SGD",
      fxRate: 1,
      paidBy: "partnerB",
      paidTo: "partnerA",
    },
    USERS,
    "SGD"
  );

  const settled = calculateBalances([exp1, exp2, pay1], USERS, "SGD");
  assert.equal(settled.isSettled, true);
  assert.equal(settled.owedAmountHome, 0);
  assert.equal(settled.expenseCount, 2);
  assert.equal(settled.settlementCount, 1);
  // Settlements should not inflate total spent
  assert.equal(settled.totalSpentHome, 72.24);
});

test("getEntryImpactForUser reports correct perspective for both partners", () => {
  const exp = createExpenseEntry(
    {
      title: "Coffee",
      date: "2026-11-25",
      amount: 12,
      currency: "SGD",
      fxRate: 1,
      paidBy: "partnerA",
      splitMode: "even",
    },
    USERS,
    "SGD"
  );

  const forA = getEntryImpactForUser(exp, "partnerA", USERS, true);
  const forB = getEntryImpactForUser(exp, "partnerB", USERS, true);
  assert.equal(forA.direction, "lent");
  assert.equal(forA.amount, 6);
  assert.equal(forB.direction, "borrowed");
  assert.equal(forB.amount, 6);
});

test("upsertEntry and deleteEntry mutate ledger immutably", () => {
  const base = createEmptyLedger("SGD");
  const exp = createExpenseEntry(
    {
      title: "Taxi",
      date: "2026-11-25",
      amount: 25,
      currency: "SGD",
      fxRate: 1,
      paidBy: "partnerA",
      splitMode: "even",
    },
    USERS,
    "SGD"
  );

  const added = upsertEntry(base, exp);
  assert.equal(base.entries.length, 0);
  assert.equal(added.entries.length, 1);

  const edited = createExpenseEntry(
    {
      title: "Airport Taxi",
      date: "2026-11-25",
      amount: 30,
      currency: "SGD",
      fxRate: 1,
      paidBy: "partnerA",
      splitMode: "even",
    },
    USERS,
    "SGD",
    exp
  );
  const updated = upsertEntry(added, edited);
  assert.equal(updated.entries.length, 1);
  assert.equal(updated.entries[0].title, "Airport Taxi");
  assert.equal(updated.entries[0].id, exp.id);

  const removed = deleteEntry(updated, exp.id);
  assert.equal(removed.entries.length, 0);
});

test("normalizeTags and getAllTags support multiple tags with deduplication and backwards compatibility", () => {
  assert.deepEqual(normalizeTags(" #Japan 2026 , Food, japan 2026 , , Hotel "), [
    "Japan 2026",
    "Food",
    "Hotel",
  ]);
  assert.deepEqual(normalizeTags(undefined), []);

  const exp1 = createExpenseEntry(
    {
      title: "Sushi",
      date: "2026-11-25",
      amount: 50,
      currency: "SGD",
      fxRate: 1,
      paidBy: "partnerA",
      splitMode: "even",
      tags: "Japan 2026, Food",
    },
    USERS,
    "SGD"
  );
  const exp2 = createExpenseEntry(
    {
      title: "Hotel",
      date: "2026-11-26",
      amount: 200,
      currency: "SGD",
      fxRate: 1,
      paidBy: "partnerB",
      splitMode: "even",
      tags: ["japan 2026", "Accommodation"],
    },
    USERS,
    "SGD"
  );
  const legacyEntry = { id: "exp_old", type: "expense", title: "Old" };

  assert.deepEqual(exp1.tags, ["Japan 2026", "Food"]);
  assert.deepEqual(exp2.tags, ["japan 2026", "Accommodation"]);
  assert.deepEqual(getAllTags([exp1, exp2, legacyEntry]), ["Accommodation", "Food", "Japan 2026"]);
});
