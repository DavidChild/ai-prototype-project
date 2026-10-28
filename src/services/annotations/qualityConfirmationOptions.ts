export const QUALITY_CONFIRMATION_OPTIONS = [
  {
    value: 'security-frequency',
    label: '安全与调用频率',
    prompt: '检查重复提交、并发请求、接口调用频率、防刷、幂等和敏感操作二次确认；结合业务给出前后端职责边界，避免无依据编造具体阈值。',
  },
  {
    value: 'frontend-trigger',
    label: '前端触发控制',
    prompt: '识别输入联想、搜索、滚动、轮询、按钮连点等可预见高频触发，明确防抖、节流、请求取消、进行中锁定、缓存或合并请求规则。',
  },
  {
    value: 'large-volume',
    label: '大数量性能优化',
    prompt: '说明数据或元素数量较多时的分页、分批加载、懒加载、虚拟列表、批量操作、加载反馈和性能降级策略。',
  },
  {
    value: 'space-capacity',
    label: '空间容量与溢出',
    prompt: '结合当前终端和可用空间，明确默认展示多少组、每组多少项、间距与排列方式，以及超出后的换行、滚动、折叠、展开、分页或省略规则。',
  },
  {
    value: 'failure-recovery',
    label: '异常与降级恢复',
    prompt: '补充加载中、空数据、超时、失败重试、弱网、重复操作和部分成功时的反馈、恢复与兜底规则。',
  },
] as const

export type QualityConfirmationOptionValue = (typeof QUALITY_CONFIRMATION_OPTIONS)[number]['value']

