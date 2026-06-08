const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WATCH_DIR = path.join(os.homedir(), '.agents', '.bridge_tasks_watch');

if (process.env.__ASYNC_WORKER__ === '1') {
  // 我们是后台独立运行的 Worker 进程
  const scope = process.argv[2];
  const command = process.argv[3];
  const args = process.argv.slice(4);

  let output = '';
  try {
    // 执行真正的长耗时命令
    // shell: true 允许我们在命令中使用管道符、逻辑符等，以及处理 Windows 下的命令解析
    const result = spawnSync(command, args, { encoding: 'utf8', shell: true });
    
    output = `Task completed with exit code ${result.status}\n`;
    if (result.stdout && result.stdout.trim()) {
      output += `\n[STDOUT]\n${result.stdout.trim()}`;
    }
    if (result.stderr && result.stderr.trim()) {
      output += `\n[STDERR]\n${result.stderr.trim()}`;
    }
    if (result.error) {
      output += `\n[ERROR]\n${result.error.message}`;
    }
  } catch (err) {
    output = `Task execution failed: ${err.message}`;
  }

  // 确保监控目录存在
  if (!fs.existsSync(WATCH_DIR)) {
    fs.mkdirSync(WATCH_DIR, { recursive: true });
  }

  // 写入 .done 触发器文件，让飞书桥接层的 taskWatcher 能够捕获并唤醒智能体
  const safeScope = encodeURIComponent(scope);
  const doneFilePath = path.join(WATCH_DIR, `${safeScope}.done`);
  fs.writeFileSync(doneFilePath, output, 'utf8');

  process.exit(0);
} else {
  // 我们是智能体主进程调用的前台包装脚本
  const scope = process.argv[2];
  const command = process.argv[3];
  
  if (!scope || !command) {
    console.error('Usage: node run_async.js <scope> <command> [args...]');
    console.error('Example: node run_async.js "p2p:xxxx" ffmpeg -i input.mp4 output.mp4');
    process.exit(1);
  }

  // 派生一个完全独立的后台 Worker 进程
  const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
    detached: true,       // 脱离进程组
    stdio: 'ignore',      // 丢弃标准输入输出，防止阻塞前台
    env: { ...process.env, __ASYNC_WORKER__: '1' }, // 注入后台标识
    windowsHide: true,    // 隐藏可能弹出的命令行窗口
  });

  // 放弃对子进程的引用，允许前台脚本立刻干净退出
  child.unref();

  console.log(`[成功] 后台任务已启动 (Scope: ${scope})。主进程已释放，任务完成后将自动通知您。`);
  process.exit(0);
}
