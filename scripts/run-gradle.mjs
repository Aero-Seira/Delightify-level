#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [, , projectDirArg, ...gradleArgs] = process.argv;

if (!projectDirArg) {
  console.error('Usage: node scripts/run-gradle.mjs <project-dir> [gradle args...]');
  process.exit(1);
}

const repoRoot = process.cwd();
const projectDir = path.resolve(repoRoot, projectDirArg);
const wrapperName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
const wrapperPath = path.join(projectDir, wrapperName);

if (!existsSync(wrapperPath)) {
  console.error(`Gradle wrapper not found: ${wrapperPath}`);
  process.exit(1);
}

const child = spawn(wrapperPath, gradleArgs, {
  cwd: projectDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Gradle terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
