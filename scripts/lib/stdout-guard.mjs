/**
 * 不变量 4.3：agent 面向的脚本，stdout 只能有一个 JSON。
 *
 * core 的 importer 与 SchemaManager 有七十多处 console.log 直写 stdout，会把
 * 调用方要解析的那个 JSON 冲掉。壳持有 stdout 契约，所以在壳里统一改道 stderr。
 *
 * 每个直接可执行的 CLI 脚本都要在**最靠前**的位置 import 本模块——晚于任何会
 * 打日志的调用就来不及了。根治要清掉 core 里的 console，见 AGENT.md §6。
 */
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
  console[level] = (...args) => {
    process.stderr.write(
      args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ') + '\n',
    );
  };
}
