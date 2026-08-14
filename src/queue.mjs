/**
 * 队列模块
 * =========
 * 约束:
 *   - 每个会话(chatId)内部串行:同一 chatId 同一时刻最多一个任务在跑;
 *   - 全局并发上限:同时运行的 agent 不超过 maxConcurrent(默认 3);
 *   - 单会话排队深度上限 maxDepth:超出时丢最旧,并把被丢弃的任务返回给调用方回复。
 */
export class BridgeQueue {
  constructor({ maxConcurrent = 3, maxDepth = 5, onTask }) {
    this.maxConcurrent = maxConcurrent;
    this.maxDepth = maxDepth;
    this.onTask = onTask;
    this.running = 0;
    this.activeChats = new Set();       // 正在运行任务的 chatId
    this.queues = new Map();            // chatId -> task[]
  }

  /**
   * 入队。
   * @param {string} chatId
   * @param {object} task 交给 onTask(task) 处理
   * @returns {object[]} 因队列超深而被丢弃的任务(调用方应给这些任务回「请稍后」)
   */
  enqueue(chatId, task) {
    const q = this.queues.get(chatId) || [];
    const dropped = [];
    while (q.length >= this.maxDepth) dropped.push(q.shift());
    q.push(task);
    this.queues.set(chatId, q);
    this.#pump();
    return dropped;
  }

  #pump() {
    while (this.running < this.maxConcurrent) {
      let entry = null;
      for (const [cid, q] of this.queues) {
        if (!this.activeChats.has(cid) && q.length > 0) {
          entry = [cid, q];
          break;
        }
      }
      if (!entry) break;
      const [cid, q] = entry;
      const task = q.shift();
      if (q.length === 0) this.queues.delete(cid);
      this.activeChats.add(cid);
      this.running += 1;
      Promise.resolve()
        .then(() => this.onTask(task))
        .catch((err) => console.error('[queue] 任务处理异常: ' + (err?.message || err)))
        .finally(() => {
          this.activeChats.delete(cid);
          this.running -= 1;
          this.#pump();
        });
    }
  }

  /** 排队中的任务总数 */
  get depth() {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }
}
