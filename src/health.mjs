/**
 * 健康检查 HTTP 服务器(仅绑定 127.0.0.1)
 */
import http from 'node:http';

export function startHealthServer(port, getStatus) {
  if (!port || port <= 0) return null;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStatus()));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('WeCom ↔ Claude Code Bridge');
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('[health] 健康检查端口: http://127.0.0.1:' + port + '/health');
  });
  server.on('error', (err) => {
    // 端口被占用 → 大概率已有另一个 bridge 实例在跑,直接退出避免抢企微长连接
    if (err.code === 'EADDRINUSE') {
      console.error('[health] 端口 ' + port + ' 已被占用,疑似另一个 bridge 实例在运行,退出');
      process.exit(1);
    }
    console.error('[health] 监听失败: ' + err.message);
  });
  return server;
}
