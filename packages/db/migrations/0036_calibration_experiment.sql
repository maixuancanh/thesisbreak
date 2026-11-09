ALTER TABLE research_job_inputs DROP CONSTRAINT research_job_inputs_operation_check;
ALTER TABLE research_job_inputs ADD CONSTRAINT research_job_inputs_operation_check
CHECK (operation IN ('calibration','calibration_experiment','online_learning','procedure_evaluate','procedure_optimize'));
