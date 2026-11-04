// 机器人类型与推送内容模式；前后端共用。
export const ROBOTS = [
  {id: 'wecom', label: '企业微信', signing: false, keyword: false, urlHint: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'},
  {id: 'feishu', label: '飞书', signing: true, keyword: true, urlHint: 'https://open.feishu.cn/open-apis/bot/v2/hook/…'},
  {id: 'dingtalk', label: '钉钉', signing: true, keyword: true, urlHint: 'https://oapi.dingtalk.com/robot/send?access_token=…'},
] as const;
export type RobotType = typeof ROBOTS[number]['id'];
export const isRobotType = (value: unknown): value is RobotType => typeof value === 'string' && ROBOTS.some(robot => robot.id === value);

export const CONTENT_MODES = [
  {id: 'summary', label: '备忘录摘要'},
  {id: 'open_todos', label: '未完成待办'},
  {id: 'all_todos', label: '全部待办'},
] as const;
export type ContentMode = typeof CONTENT_MODES[number]['id'];
export const isContentMode = (value: unknown): value is ContentMode => typeof value === 'string' && CONTENT_MODES.some(mode => mode.id === value);
