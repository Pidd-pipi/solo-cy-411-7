export const Messages = {
  FRONTEND_ACTIVITY_SAVED: '活动记录已同步到碳账本',
  FRONTEND_GOAL_SAVED: '减排目标已更新',
  FRONTEND_PROFILE_SAVED: '个人资料已保存',
  FRONTEND_FACTOR_REQUIRED: '请先选择匹配的排放因子',
  FRONTEND_PERIOD_CLOSED: '该月账期已结账，活动不能补录、调整或撤销',
  FRONTEND_PERIOD_CLOSE_OK: '账期结账完成，快照已冻结',
  FRONTEND_PERIOD_REOPEN_OK: '账期已重开，恢复实时数据',
  FRONTEND_PERIOD_REOPEN_REASON: '请填写重开原因',
  BACKEND_SHARED_COPY: '前后端耦合文案：修改文案时需要同步后端 constants/messages.ts',
  LOG_ACTIVITY_CATEGORY: 'ActivityCategory affects filters, chart legends, logs and errors',
  LOG_GOAL_STATUS: 'GoalStatus affects list badges, progress cards, logs and errors'
} as const;

