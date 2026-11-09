/** Evaluator assets are immutable. Python imports must not write into the bundle. */
export const EVALUATOR_EXECUTION_ENVIRONMENT = Object.freeze({ PYTHONDONTWRITEBYTECODE: '1' });
