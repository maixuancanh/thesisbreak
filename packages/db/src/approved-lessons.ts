import { disputedLessonDependencySql } from "./explanation-reviews";
import type { Pool } from "pg";
import { lessonRowToPayload } from "./memory-outbox";
/** Current authority, shared by recall and its disposable derived index. */
export async function loadCurrentApprovedLessons(
  pool: Pick<Pool, "query">,
  userId: string,
) {
  const found = await pool.query(
    `SELECT v.* FROM lessons l JOIN lesson_versions v ON v.lesson_id=l.id AND v.user_id=l.user_id AND v.version=l.current_version
     WHERE l.user_id=$1 AND v.approval='approved' AND v.status='active' AND v.superseded_by IS NULL
     AND EXISTS (SELECT 1 FROM outbox o WHERE o.user_id=l.user_id AND o.kind='lesson.version.created' AND o.payload->>'lessonId'=l.id AND o.payload->>'version'=l.current_version::text AND o.payload->'memoryConsent'='true'::jsonb)
     AND NOT EXISTS (SELECT 1 FROM lesson_candidates lc JOIN lesson_candidate_evidence ce ON ce.user_id=lc.user_id AND ce.candidate_id=lc.id AND ce.candidate_version=lc.version JOIN memory_atoms a ON a.user_id=ce.user_id AND a.id=ce.atom_id AND a.version=ce.atom_version WHERE lc.user_id=l.user_id AND lc.lesson_id=l.id AND lc.lesson_version=v.version AND ce.stance='support' AND (a.withdrawn_at IS NOT NULL OR (a.payload->>'origin'='verified_outcome' AND NOT EXISTS(SELECT 1 FROM action_memory_preferences ap WHERE ap.user_id=l.user_id AND ap.memory_consent=true))))
     AND NOT EXISTS (SELECT 1 FROM lesson_candidates lc CROSS JOIN LATERAL jsonb_array_elements_text(lc.payload->'experienceIds') e(id) JOIN learning_experiences le ON le.user_id=lc.user_id AND le.id=e.id JOIN conversations co ON co.user_id=le.user_id AND co.id=le.session_id WHERE lc.user_id=l.user_id AND lc.lesson_id=l.id AND lc.lesson_version=v.version AND co.memory_consent=false)
     AND ${disputedLessonDependencySql}
     ORDER BY l.id LIMIT 50`,
    [userId],
  );
  return found.rows.map(lessonRowToPayload);
}
