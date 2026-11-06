import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runProcess } from '../lib/agy/process.js'

// agy 的后台自更新每约 15 分钟派生 --bg-updater，其子进程自带可见控制台窗口，
// 就是间歇闪出的黑框。官方开关 AGY_CLI_DISABLE_AUTO_UPDATE 只认字面小写字符串
// 'true'（'1' / 'TRUE' / 布尔 true 都不生效），且在读取 TTL 之前就检查。
// 插件在拉起主 agy 的 3 处 env 组装点逐处注入该键并放在最后，保证任意调用路径下
// 子进程都带该键且值为小写 true，同时不改全局 process.env、不动启动器标志。
// 这里钉住 3 处源码注入值，并用真实子进程验证它确实进了 child env。

const srcDir = fileURLToPath(new URL('../src/agy/', import.meta.url))
const spawnSources = [
  'process.ts',
  'experimental-transport.ts',
  'persistent-transport.ts',
]

for (const name of spawnSources) {
  test(`agy spawn 点 ${name} 注入字面小写 'true'`, async () => {
    const source = await readFile(`${srcDir}${name}`, 'utf8')
    const values = [...source.matchAll(/AGY_CLI_DISABLE_AUTO_UPDATE:\s*('[^']*'|"[^"]*"|[^,\s}]+)/g)]
      .map(match => match[1])
    assert.ok(values.length > 0, `${name} 缺少 AGY_CLI_DISABLE_AUTO_UPDATE 注入`)
    for (const value of values) {
      assert.equal(value, "'true'", `${name} 的值必须是字面小写 'true'，实际为 ${value}`)
    }
  })
}

test('runProcess 把 AGY_CLI_DISABLE_AUTO_UPDATE 以小写 true 传给子进程', async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'console.log(String(process.env.AGY_CLI_DISABLE_AUTO_UPDATE))'],
  })
  assert.equal(result.termination, 'completed')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.stdoutLines, ['true'])
})

test('调用方传入其它值仍强制为小写 true', async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'console.log(String(process.env.AGY_CLI_DISABLE_AUTO_UPDATE))'],
    env: { AGY_CLI_DISABLE_AUTO_UPDATE: '1' },
  })
  assert.equal(result.termination, 'completed')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.stdoutLines, ['true'])
})
