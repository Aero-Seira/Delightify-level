/**
 * Global health monitoring contract.
 *
 * Main process runs lightweight checks (settings, LLM provider, project
 * database, knowledge sync state). Renderer polls via IPC and renders the
 * aggregate state in the status bar plus bottom-right toasts on change.
 */

export type HealthLevel = 'healthy' | 'degraded' | 'unavailable' | 'unknown';

export type HealthServiceKind = 'settings' | 'llm' | 'database' | 'knowledge' | 'project';

export interface HealthCheckItem {
  id: string;
  kind: HealthServiceKind;
  level: HealthLevel;
  message: string;
  checkedAt: string;
  latencyMs: number;
  details?: Record<string, unknown>;
}

export interface HealthSnapshot {
  overall: HealthLevel;
  items: HealthCheckItem[];
  checkedAt: string;
}

export interface HealthMonitorSettings {
  monitorEnabled: boolean;
  intervalSeconds: number;
  notifyOnChange: boolean;
  checkOnStartup: boolean;
}
