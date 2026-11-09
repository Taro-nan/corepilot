import path from 'node:path';
import type { ValidationCommand } from '../contracts/validation-testpack.js';
import { isolatedCmakeArtifact, isolatedWorkspaceBuild } from '../config/build-command.js';

/** Apply the same CMake isolation used by onboarding trials to actual target experiments. */
export function remoteWorkspaceBuild(input: {
  build: ValidationCommand; cwdRelative: string; sourceRoot: string; buildRoot: string; artifactPath: string;
}): { command: ValidationCommand; artifactPath: string } {
  const target = input.sourceRoot.startsWith('/') ? path.posix : path;
  const definition = { ...input.build, cwd: input.cwdRelative.replaceAll('\\', '/') || '.' };
  const isolated = isolatedWorkspaceBuild(definition);
  const relativeArtifact = target.relative(input.sourceRoot, input.artifactPath).replaceAll('\\', '/');
  const relocated = isolated !== definition ? isolatedCmakeArtifact(definition, relativeArtifact) : null;
  return {
    command: { ...isolated, cwd: target.join(input.sourceRoot, definition.cwd), environment: { ...isolated.environment,
      COREPILOT_SOURCE_ROOT: input.sourceRoot, COREPILOT_BUILD_ROOT: input.buildRoot } },
    artifactPath: relocated !== null ? target.join(input.buildRoot, relocated) : input.artifactPath,
  };
}
