// Fixture log text: three CLI runs; each has one gRPC (HTTPS) port and one HTTP port.
// Includes a decoy `127.0.0.1:port` error line that must NOT be picked up.
export const CLI_LOG_SAMPLE = [
  'I1125 01:04:48.221118      66 server.go:1292] Language server listening on random port at 52236 for HTTP',
  'W1123 10:55:00.779479     275 errorreport.go:307] Get "https://www.googleapis.com/oauth2/v2/userinfo": read tcp 127.0.0.1:52473->127.0.0.1:12450: wsarecv: connection closed',
  'I1125 01:05:30.172452      22 server.go:1284] Language server listening on random port at 52387 for HTTPS (gRPC)',
  'I1125 01:05:30.172969      22 server.go:1292] Language server listening on random port at 52388 for HTTP',
  'I1125 01:08:00.780907      52 server.go:1284] Language server listening on random port at 53244 for HTTPS (gRPC)',
  'I1125 01:08:00.781453      52 server.go:1292] Language server listening on random port at 53245 for HTTP',
  'I1125 01:08:00.781453      52 server.go:1292] Language server listening on random port at 53245 for HTTP',
].join('\n')

export const GET_USER_STATUS_SAMPLE = JSON.stringify({
  userStatus: {
    monthlyPromptCredits: 100,
    availablePromptCredits: 42,
    models: [
      {
        label: 'Gemini 3.8 Flash',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
        quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-25T06:00:00Z' },
      },
      {
        label: 'Gemini 3.8 Pro',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M400' },
        quotaInfo: { remainingFraction: 0.3333, resetTime: '2026-11-25T06:00:00Z' },
      },
      {
        label: 'Gemini 4 Argon',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M668' },
        disabled: true,
        quotaInfo: {},
      },
      { label: 'Broken row', quotaInfo: {} },
    ],
  },
})

export const QUOTA_SUMMARY_SAMPLE = JSON.stringify({
  groups: [
    {
      groupName: 'gemini',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.8, resetTime: '2026-11-27T08:00:00.000Z' },
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75, resetTime: '2026-11-25T06:00:00.000Z' },
        { bucketId: '3p-weekly', window: 'weekly', remainingAmount: 42, resetTime: '2026-11-27T08:00:00.000Z' },
      ],
    },
  ],
})
