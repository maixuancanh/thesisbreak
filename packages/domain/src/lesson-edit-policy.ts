import type { z } from "zod";
import type { lessonVersionSchema } from "./lesson";

type Lesson = z.infer<typeof lessonVersionSchema>;
type Editable = Pick<Lesson, "rule" | "scope">;

/** A prose edit is not a reviewed re-compilation of the old machine policy. */
export function reviewedLessonEdit<
  T extends Editable &
    Partial<Pick<Lesson, "learningCondition" | "learningScope">>,
>(base: T, edit: Editable) {
  const sameScope = (["domain", "competition", "sourceClass"] as const).every(
    (key) => base.scope[key] === edit.scope[key],
  );
  const { learningCondition, ...rest } = base;
  return {
    ...rest,
    ...edit,
    // Keep learningScope as an additional restriction. Editing visible prose
    // cannot turn an event-specific experience into an account-wide procedure.
    ...(base.rule === edit.rule && sameScope && learningCondition
      ? { learningCondition }
      : {}),
  };
}
