import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// DETACHED_PROCESS (0x00000008) 与 CREATE_NO_WINDOW (0x08000000) 同时给出时前者胜出：
// 子进程实际上没有控制台。agy.exe 是 console 子系统，运行中自己分配控制台时 Windows
// 会建出一个真实控制台窗口并在屏幕上短暂可见——就是每 turn 开头一闪的黑框。
// 只留 CREATE_NO_WINDOW 时子进程拿到一个不可见控制台，窗口不会被建出来。
// 这条实测结论没法在测试里直接观测窗口，所以在这里钉住源码里的启动标志。

const launcherSource = fileURLToPath(
  new URL('../native/windows-launcher/Program.cs', import.meta.url),
)

test('Windows launcher never combines DETACHED_PROCESS with CREATE_NO_WINDOW', async () => {
  const source = await readFile(launcherSource, 'utf8')
  const creationFlagsLine = source
    .split(/\r?\n/)
    .find(line => line.includes('var creationFlags'))

  assert.ok(creationFlagsLine, 'launcher source should declare creationFlags')
  assert.match(creationFlagsLine, /CreateNoWindow/)
  assert.doesNotMatch(creationFlagsLine, /DetachedProcess/)
  // 常量定义、别名或其它写法也一律不放过：只要启动器里出现 DETACHED_PROCESS 就算回归。
  assert.doesNotMatch(source, /DetachedProcess|DETACHED_PROCESS/i)
})
