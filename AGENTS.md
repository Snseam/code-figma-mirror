# 项目设计约定

## Modern Web Guidance

设计或修改本项目的 Web 界面时，默认使用 GoogleChrome 的 [Modern Web Guidance](.agents/skills/modern-web-guidance/SKILL.md)。范围包括桌面与移动 Web、示例应用、Figma 插件的 HTML 界面、验收报告和浏览器端交互。

1. 开工时按 skill 用简短英文描述本次要实现的能力，执行 `search`，再 `retrieve` 命中的指南。例如，处理弹窗先查 `light dismiss dialog`。
2. 根据目标浏览器、键盘和触摸交互、响应式布局选择指南中适用的做法。使用新特性时按指南核对 Baseline 与回退。
3. 验收时在相应尺寸操作该功能，并在交付说明中记录所用指南及验证结果。

复刻已有产品时，原界面的实测外观、组件身份和交互是验收依据。指南用于设计工具自身及明确授权的前端改动。使用统一字体等实验条件时，保留原始参考图，并在单独的报告中标明实验条件。
