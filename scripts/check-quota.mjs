#!/usr/bin/env node
// Local no-login quota sniff: discover the running AGY language server, ask for
// the quota summary, print per-model remaining percentage + reset countdown.
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { discoverCsrfToken, readLogPorts } from '../lib/quota/discovery.js'
import { parseDelimitedJson, parseModelRows, parseSummaryBuckets, renderReport } from '../lib/quota/summary.js'

const LOG_DIR = process.env.AGY_QUOTA_LOG_DIR ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log')
const REQUEST_TIMEOUT_MS = 5000

function fail(message) {
  console.error(`[quota] ${message}`)
  process.exitCode = 1
}

const GET_USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus'
const QUOTA_SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'

function requestJson(protocol, port, apiPath, csrfToken) {
  const body = JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } })
  return new Promise((resolve) => {
    const client = protocol === 'https' ? https : http
    const request = client.request(
      {
        hostname: '127.0.0.1',
        port,
        path: apiPath,
        method: 'POST',
        ...(protocol === 'https' ? { rejectUnauthorized: false } : {}),
        headers: {
          'X-Codeium-Csrf-Token': csrfToken,
          'Connect-Protocol-Version': '1',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body: text }))
      },
    )
    request.on('error', () => resolve(null))
    request.on('timeout', () => {
      request.destroy()
      resolve(null)
    })
    request.end(body)
  })
}

async function main() {
  const { ports } = readLogPorts(LOG_DIR)
  if (ports.length === 0) {
    fail(`在 ${LOG_DIR} 的 CLI 日志里没有找到本地服务端口；AGY CLI 可能从未启动过。`)
    return
  }
  const csrfToken = await discoverCsrfToken()
  if (!csrfToken) {
    fail('没有发现运行中的 AGY language server 进程（找不到 csrf_token）；请先启动并登录 AGY CLI。')
    return
  }

  for (const port of ports) {
    for (const protocol of ['http', 'https']) {
      const status = await requestJson(protocol, port, GET_USER_STATUS_PATH, csrfToken)
      if (!status) continue
      if (status.statusCode === 401 || status.statusCode === 403) continue
      if (status.statusCode < 200 || status.statusCode >= 300) continue
      const statusResponses = parseDelimitedJson(status.body)
      const models = parseModelRows(statusResponses)
      if (models.length === 0) {
        fail(`端口 ${port} 应答了，但响应里没有可解析的模型配额行（协议可能已变更）。`)
        return
      }
      const summary = await requestJson(protocol, port, QUOTA_SUMMARY_PATH, csrfToken)
      const buckets = summary && summary.statusCode >= 200 && summary.statusCode < 300
        ? parseSummaryBuckets(parseDelimitedJson(summary.body))
        : []
      console.log(renderReport(models, buckets))
      return
    }
  }
  fail(`探测过端口 ${ports.join(', ')}，均不可达或拒绝访问；AGY CLI 可能已退出。`)
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
