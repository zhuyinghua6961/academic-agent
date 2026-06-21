import {resolve} from "node:path";

export function resolveProjectRoot({cwd, env}) {
  return resolve(env.ACADEMIC_AGENT_PROJECT_ROOT || cwd);
}

export function configPaths({home, projectRoot, repoRoot, env}) {
  const paths = [];
  if (home) {
    paths.push(resolve(home, ".academic-agent", "config.toml"));
  }
  paths.push(resolve(projectRoot, ".academic-agent", "config.toml"));
  if (resolve(projectRoot) === resolve(repoRoot)) {
    const repoConfig = resolve(repoRoot, ".academic-agent", "config.toml");
    if (!paths.includes(repoConfig)) {
      paths.push(repoConfig);
    }
  }
  if (env.ACADEMIC_AGENT_CONFIG) {
    paths.push(resolve(env.ACADEMIC_AGENT_CONFIG));
  }
  return paths;
}
