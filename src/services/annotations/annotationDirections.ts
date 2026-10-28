export const ANNOTATION_DIRECTION_OPTIONS = [
  { label: '字段含义', value: '字段含义与数据口径' },
  { label: '字段规则', value: '字段必填、格式、取值与校验规则' },
  { label: '字数说明', value: '文本或字段的字符长度、计数方式、最小与最大边界规则' },
  {
    label: '超界规则说明',
    value: '内容超出字数、数量或容器边界后的截断、省略、换行、滚动、展开和提示规则',
  },
  { label: '弹窗', value: '弹窗触发条件与交互流程' },
  { label: '弹窗规则', value: '弹窗关闭、确认、重复出现与状态规则' },
  { label: '频率', value: '触发频率、次数限制与冷却规则' },
  { label: '推荐', value: '推荐内容及展示条件' },
  { label: '推荐规则', value: '推荐排序、过滤、兜底与刷新规则' },
  { label: '状态与权限', value: '状态条件、角色权限与不可用原因' },
  { label: '流程与异常', value: '流程前后置、操作影响与异常处理' },
] as const
