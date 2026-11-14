/**
 * Shared types for the Loops screen.
 *
 * The bridge record type is the ambient global `LoopView` (env.d.ts). The
 * screen class in LoopView.ts shares that name, so the record is re-exported
 * here under a clash-free alias for use inside the screen modules.
 */
export type LoopRecordView = LoopView;

/** Cadence kind selector values (mirror of src/loops/schedule.ts kinds). */
export type LoopCadenceKind = LoopCadence["kind"];
