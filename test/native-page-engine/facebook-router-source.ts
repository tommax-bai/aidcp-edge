import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROUTER_DIRECTORY = 'native/page-engine/src/facebook-router';
const MANIFEST_NAME = 'manifest.txt';

/**
 * Facebook 路由明文源的 TypeScript 复刻拼接。
 *
 * 十来条路由契约用例把这个函数的返回值当作「引擎真正会执行的那段源码」。
 * 因此它的拼接规则必须与构建期的 `native/page-engine/build.rs::read_ordered_sources`
 * **完全一致**，否则那些用例断言的是一段二进制里并不存在的源码 —— 而它们仍然全绿。
 *
 * 同步的四条规则（与 build.rs 逐条对应）：
 * ① 条目唯一、是本地文件名、按词典序递增（词典序即执行结构序）；
 * ② 每片必须以换行结尾 —— 不插分隔字节而选断言，理由见 build.rs 同名注释：
 *    插分隔符会改变已编入二进制的字节。缺尾随换行且末行是行注释时，
 *    下一片首行会被注释掉，结果仍是合法脚本、只是某个函数凭空消失；
 * ③ 片间不插入任何字节；
 * ④ 目录里不得有未登记分片（未登记的分片不会进二进制，运行时静默走缺失逻辑）。
 *
 * 两份实现逐字节相等由 `test/native-page-engine/artifact-gates.test.ts` 断言，
 * 对照实现是 `scripts/native-engine-inventory.cjs` 的 `concatenateFragments()`。
 */
export async function readFacebookRouterSource(repoRoot: string): Promise<string> {
  const directory = resolve(repoRoot, ROUTER_DIRECTORY);
  const manifest = await readFile(resolve(directory, MANIFEST_NAME), 'utf8');
  const fragments = manifest
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (fragments.length === 0 || new Set(fragments).size !== fragments.length) {
    throw new Error('Facebook router manifest must name a non-empty unique source set');
  }
  if (fragments.some((entry) => entry.includes('/') || entry.includes('\\'))) {
    throw new Error('Facebook router manifest entries must be local file names');
  }
  if (fragments.some((entry, index) => index > 0 && fragments[index - 1]! >= entry)) {
    throw new Error('Facebook router manifest entries must remain in lexical assembly order');
  }
  const present = (await readdir(directory, { withFileTypes: true }))
    .filter((item) => item.isFile() && item.name !== MANIFEST_NAME)
    .map((item) => item.name);
  const unregistered = present.filter((name) => !fragments.includes(name));
  if (unregistered.length > 0) {
    throw new Error(
      `page-rule fragment is not registered in the ordered source manifest: ${unregistered.join(', ')}`,
    );
  }
  const contents = await Promise.all(
    fragments.map(async (entry) => {
      const fragment = await readFile(resolve(directory, entry), 'utf8');
      if (!fragment.endsWith('\n')) {
        throw new Error(
          `page-rule fragment must end with a newline before concatenation: ${ROUTER_DIRECTORY}/${entry}`,
        );
      }
      return fragment;
    }),
  );
  return contents.join('');
}
