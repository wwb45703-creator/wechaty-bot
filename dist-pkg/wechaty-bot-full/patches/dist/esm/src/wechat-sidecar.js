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
import fs from 'fs';
import path from 'path';
import { Sidecar, SidecarBody, Call, Hook, ParamType, Ret, agentTarget,
// attach,
// detach,
 } from 'sidecar';
import { codeRoot } from './cjs.js';
const scriptPath = path.join(codeRoot, 'src', 'init-agent-script.js');
const initAgentScript = fs.readFileSync(scriptPath, 'utf-8');
let WeChatSidecar = class WeChatSidecar extends SidecarBody {
    getMyselfInfo() { return Ret(); }
    contactList() { return Ret(); }
    roomList() { return Ret(); }
    sendMsg(contactId, text) { return Ret(contactId, text); }
    sendPicMsg(contactId, imagePath) { return Ret(contactId, imagePath); }
    patMsg(roomId, contactId) { return Ret(roomId, contactId); }
    probeOffsets() { return Ret(); }
    disasmFunc(key, count) { return Ret(key, count); }
    recvMsg(msgType, contactId, text, groupMsgSenderId, xmlContent, isMyMsg) { return Ret(msgType, contactId, text, groupMsgSenderId, xmlContent, isMyMsg); }
};
__decorate([
    Call(agentTarget('contactSelfInfo')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "getMyselfInfo", null);
__decorate([
    Call(agentTarget('contactList')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "contactList", null);
__decorate([
    Call(agentTarget('roomList')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "roomList", null);
__decorate([
    Call(agentTarget('messageSendText')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "sendMsg", null);
__decorate([
    Call(agentTarget('sendImageMsg')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "sendPicMsg", null);
__decorate([
    Call(agentTarget('sendPatMsg')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "patMsg", null);
__decorate([
    Call(agentTarget('probeOffsets')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "probeOffsets", null);
__decorate([
    Call(agentTarget('disasmFunc')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number]),
    __metadata("design:returntype", Promise)
], WeChatSidecar.prototype, "disasmFunc", null);
__decorate([
    Hook(agentTarget('recvMsgNativeCallback')),
    __param(0, ParamType('int32', 'U32')),
    __param(1, ParamType('pointer', 'Utf16String')),
    __param(2, ParamType('pointer', 'Utf16String')),
    __param(3, ParamType('pointer', 'Utf16String')),
    __param(4, ParamType('pointer', 'Utf16String')),
    __param(5, ParamType('int32', 'U32')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, String, String, String, String, Number]),
    __metadata("design:returntype", void 0)
], WeChatSidecar.prototype, "recvMsg", null);
WeChatSidecar = __decorate([
    Sidecar('WeChat.exe', initAgentScript)
], WeChatSidecar);
export { WeChatSidecar };
//# sourceMappingURL=wechat-sidecar.js.map