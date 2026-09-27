"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WeChatSidecar = void 0;
/**
 *   Sidecar - https://github.com/huan/sidecar
 *
 *   @copyright 2021 Huan LI (李卓桓) <https://github.com/huan>
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 *
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const sidecar_1 = require("sidecar");
const cjs_js_1 = require("./cjs.js");
const scriptPath = path_1.default.join(cjs_js_1.codeRoot, 'src', 'init-agent-script.js');
const initAgentScript = fs_1.default.readFileSync(scriptPath, 'utf-8');
let WeChatSidecar = class WeChatSidecar extends sidecar_1.SidecarBody {
    getMyselfInfo() { return (0, sidecar_1.Ret)(); }
    contactList() { return (0, sidecar_1.Ret)(); }
    roomList() { return (0, sidecar_1.Ret)(); }
    sendMsg(contactId, text) { return (0, sidecar_1.Ret)(contactId, text); }
    sendPicMsg(contactId, imagePath) { return (0, sidecar_1.Ret)(contactId, imagePath); }
    patMsg(roomId, contactId) { return (0, sidecar_1.Ret)(roomId, contactId); }
    recvMsg(msgType, contactId, text, groupMsgSenderId, xmlContent, isMyMsg) { return (0, sidecar_1.Ret)(msgType, contactId, text, groupMsgSenderId, xmlContent, isMyMsg); }
};
__decorate([
    (0, sidecar_1.Call)((0, sidecar_1.agentTarget)('contactSelfInfo')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "getMyselfInfo", null);
__decorate([
    (0, sidecar_1.Call)((0, sidecar_1.agentTarget)('contactList')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "contactList", null);
__decorate([
    (0, sidecar_1.Call)((0, sidecar_1.agentTarget)('roomList')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "roomList", null);
__decorate([
    (0, sidecar_1.Call)((0, sidecar_1.agentTarget)('messageSendText')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "sendMsg", null);
__decorate([
    (0, sidecar_1.Call)((0, sidecar_1.agentTarget)('sendImageMsg')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "sendPicMsg", null);
__decorate([
    (0, sidecar_1.Call)((0, sidecar_1.agentTarget)('sendPatMsg')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "patMsg", null);
__decorate([
    (0, sidecar_1.Hook)((0, sidecar_1.agentTarget)('recvMsgNativeCallback')),
    __param(0, (0, sidecar_1.ParamType)('int32', 'U32')),
    __param(1, (0, sidecar_1.ParamType)('pointer', 'Utf16String')),
    __param(2, (0, sidecar_1.ParamType)('pointer', 'Utf16String')),
    __param(3, (0, sidecar_1.ParamType)('pointer', 'Utf16String')),
    __param(4, (0, sidecar_1.ParamType)('pointer', 'Utf16String')),
    __param(5, (0, sidecar_1.ParamType)('int32', 'U32')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, String, String, String, String, Number]),
    __metadata("design:returntype", void 0)
], WeChatSidecar.prototype, "recvMsg", null);
WeChatSidecar = __decorate([
    (0, sidecar_1.Sidecar)('WeChat.exe', initAgentScript)
], WeChatSidecar);
exports.WeChatSidecar = WeChatSidecar;
//# sourceMappingURL=wechat-sidecar.js.map