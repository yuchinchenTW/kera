export const CHAT_TEMPLATES = {
  accuse: [
    (s, t) => `${s}: I think ${t} is suspicious.||${s}：我覺得 ${t} 很可疑。`,
    (s, t) => `${s}: ${t} feels off to me.||${s}：${t} 給我的感覺不太對勁。`,
    (s, t) => `${s}: Something about ${t} doesn't add up.||${s}：${t} 的行為有矛盾。`,
    (s, t) => `${s}: We should look into ${t}.||${s}：我們應該注意 ${t}。`,
    (s, t) => `${s}: ${t} has been acting weird.||${s}：${t} 一直表現得很奇怪。`,
    (s, t) => `${s}: I don't trust ${t} at all.||${s}：我完全不信任 ${t}。`,
  ],
  defend: [
    (s, t) => `${s}: I think ${t} is on our side.||${s}：我覺得 ${t} 是自己人。`,
    (s, t) => `${s}: ${t} seems fine to me.||${s}：${t} 看起來沒問題。`,
    (s, t) => `${s}: Leave ${t} alone, they're not the problem.||${s}：別針對 ${t} 了，問題不在他。`,
    (s, t) => `${s}: ${t} has been helpful so far.||${s}：${t} 到目前為止一直有在幫忙。`,
  ],
  wonder: [
    (s, t) => `${s}: What does everyone think about ${t}?||${s}：大家覺得 ${t} 怎麼樣？`,
    (s, t) => `${s}: I'm not sure about ${t} yet.||${s}：我對 ${t} 還拿不定主意。`,
    (s, t) => `${s}: Anyone have thoughts on ${t}?||${s}：有人注意到 ${t} 嗎？`,
    (s, t) => `${s}: ${t} is hard to read...||${s}：${t} 讓人看不透⋯`,
  ],
  voteRef: [
    (s, t, extra) => `${s}: ${t} voted for ${extra} last time, that's suspicious.||${s}：${t} 上次投了 ${extra}，很可疑。`,
    (s, t, extra) => `${s}: Why did ${t} switch their vote to ${extra}?||${s}：${t} 為什麼臨時改投 ${extra}？`,
    (s, t, extra) => `${s}: ${t} keeps targeting ${extra}, are they allies?||${s}：${t} 一直針對 ${extra}，他們是同夥嗎？`,
  ],
  deathRef: [
    (s, t, dead) => `${s}: ${t} defended ${dead} before they died... think about that.||${s}：${t} 在 ${dead} 死前幫他說話⋯大家想想。`,
    (s, t, dead) => `${s}: Ever since ${dead} died, ${t} has been quiet.||${s}：自從 ${dead} 死了之後，${t} 就不太說話了。`,
    (s, t, dead) => `${s}: After ${dead} died, I started watching ${t} more closely.||${s}：${dead} 死後我就一直在觀察 ${t}。`,
  ],
  bluff: [
    (s, t) => `${s}: I'm pretty sure ${t} is the killer.||${s}：我很確定 ${t} 就是殺手。`,
    (s, t) => `${s}: ${t} is definitely suspicious, I've been watching them.||${s}：${t} 絕對有問題，我一直在觀察他。`,
    (s, t) => `${s}: We need to vote ${t} out today!||${s}：今天一定要把 ${t} 投出去！`,
    (s, t) => `${s}: Trust me on this, ${t} is not who they seem.||${s}：相信我，${t} 不是表面看起來那樣。`,
  ],
  deflect: [
    (s) => `${s}: I'm not sure who to suspect right now.||${s}：我現在還不確定該懷疑誰。`,
    (s) => `${s}: Let's think about this carefully.||${s}：大家冷靜想想吧。`,
    (s) => `${s}: I want to hear what others think first.||${s}：我想先聽聽其他人的想法。`,
    (s) => `${s}: This is getting complicated...||${s}：事情越來越複雜了⋯`,
  ],
  policeReveal: [
    (s, t) => `${s}: I investigated ${t} and they're RED!||${s}：我查了 ${t}，他是紅方！`,
    (s, t) => `${s}: ${t} is confirmed red, we need to vote them out.||${s}：${t} 確認是紅方，必須投掉。`,
  ],
  policeClear: [
    (s, t) => `${s}: I checked ${t}, they're clean.||${s}：我查了 ${t}，他是好人。`,
    (s, t) => `${s}: ${t} is confirmed blue, leave them alone.||${s}：${t} 確認是藍方，別投他。`,
  ],
  // Improvement 4: Emotion-specific chat
  emotionChat: {
    angry: [
      (s, t) => `${s}: Why did you all vote for me?! I'm NOT the killer!||${s}：為什麼都投我？！我不是殺手！`,
      (s, t) => `${s}: You're wasting time on me while the real killer is still out there!||${s}：你們浪費時間在我身上，真正的殺手還在外面！`,
      (s, t) => `${s}: ${t}, you voted for me — explain yourself!||${s}：${t}，你投了我，給個解釋！`,
    ],
    defensive: [
      (s) => `${s}: I've been helping the team from the start, check my record.||${s}：我從頭到尾都在幫大家，看看我的紀錄。`,
      (s) => `${s}: If I was the killer, why would I accuse known reds?||${s}：如果我是殺手，我為什麼會指控已知的紅方？`,
    ],
    grateful: [
      (s) => `${s}: Thanks for saving me last night, I owe you one.||${s}：謝謝昨晚救了我，我欠你一次。`,
      (s) => `${s}: Someone protected me... I'll repay the favor by finding the killer.||${s}：有人保護了我⋯我會找出殺手來報答的。`,
    ],
    anxious: [
      (s, t) => `${s}: I have a bad feeling about tonight...||${s}：我對今晚有不好的預感⋯`,
      (s, t) => `${s}: I think they're coming for me next.||${s}：我覺得他們下一個就是要殺我。`,
      (s, t) => `${s}: If I die tonight, look into ${t}.||${s}：如果我今晚死了，去查 ${t}。`,
    ],
  },
  // Improvement 5: Responsive reply chat
  replyChat: {
    agree: [
      (s, t, target) => `${s}: I agree with ${t}, ${target} is suspicious.||${s}：我同意 ${t} 的看法，${target} 很可疑。`,
      (s, t, target) => `${s}: ${t} has a point about ${target}, we should listen.||${s}：${t} 說的 ${target} 有道理，大家應該聽。`,
    ],
    disagree: [
      (s, t, target) => `${s}: ${t}, I disagree — ${target} seems fine to me.||${s}：${t}，我不同意，${target} 看起來沒問題。`,
      (s, t, target) => `${s}: ${t}, I don't think ${target} is the problem, think again.||${s}：${t}，我不覺得 ${target} 有問題，再想想。`,
    ],
    question: [
      (s, t) => `${s}: ${t}, why do you think that?||${s}：${t}，你為什麼這麼想？`,
      (s, t) => `${s}: ${t}, what evidence do you have?||${s}：${t}，你有什麼證據？`,
    ],
  },
  // Improvement 6: Bandwagon & counter
  bandwagon: [
    (s, t) => `${s}: Everyone's right about ${t}, let's vote them out.||${s}：大家說的對，${t} 有問題，投他。`,
    (s, t) => `${s}: Yeah, ${t} is definitely the one.||${s}：對，${t} 一定是。`,
  ],
  counter: [
    (s, t) => `${s}: Hold on, you're all wrong about ${t}!||${s}：等等，你們都搞錯了，${t} 不是！`,
    (s, t) => `${s}: Stop ganging up on ${t}, there's no proof.||${s}：別圍攻 ${t} 了，沒有證據。`,
  ],
  // Improvement 10: Vote explanation chat
  followReveal: [
    (s, t) => `${s}: If the police say ${t} is red, I'm voting them.||${s}：如果警察說 ${t} 是紅方，我就投他。`,
    (s, t) => `${s}: I trust the police on this — voting ${t}.||${s}：這次我相信警察——投 ${t}。`,
    (s, t) => `${s}: ${t} was called out as red. I'll follow that lead.||${s}：${t} 被指認紅方了。我跟著投。`,
    (s, t) => `${s}: Sounds like ${t} is red. Count me in on the vote.||${s}：聽起來 ${t} 是紅方。算我一票。`,
  ],
  voteExplain: [
    (s, t) => `${s}: I'm voting ${t} because their behavior has been suspicious.||${s}：我投 ${t}，因為他行為一直很可疑。`,
    (s, t) => `${s}: ${t} has to go — look at who they've been defending.||${s}：${t} 必須出去，看看他一直在幫誰說話。`,
    (s, t) => `${s}: My vote goes to ${t}, I've been watching them.||${s}：我投 ${t}，我一直在觀察他。`,
    (s, t) => `${s}: I'm voting ${t} based on last night's results.||${s}：根據昨晚的結果，我投 ${t}。`,
  ],
  voteCorrection: [
    (s, t) => `${s}: On second thought, I'm going with ${t}.||${s}：再想想，我選 ${t}。`,
    (s, t) => `${s}: Changed my mind — ${t} seems like the right call now.||${s}：我改主意了，現在覺得 ${t} 比較對。`,
    (s, t) => `${s}: Reconsidering... going with ${t} instead.||${s}：重新考慮⋯改選 ${t}。`,
  ],
  voteAbstain: [
    (s) => `${s}: I'm not confident in anyone... abstaining for now.||${s}：我對誰都沒把握⋯先棄票。`,
  ],
  // Improvement 13: Fake police claim
  fakePoliceClaim: [
    (s, t) => `${s}: I'm the police. I investigated ${t} last night — they're RED.||${s}：我是警察。我昨晚查了 ${t}，他是紅方。`,
    (s, t) => `${s}: Police report: ${t} is confirmed RED. Vote them out!||${s}：警察報告：${t} 確認紅方。投掉他！`,
  ],
  // Improvement 14: Trust building chat
  trustBuild: [
    (s, t) => `${s}: I've been thinking about it — ${t} has been on our side so far.||${s}：我想了一下，${t} 到目前為止一直有在幫忙。`,
    (s, t) => `${s}: ${t} can't be the killer, their behavior is too consistent.||${s}：${t} 不可能是殺手，他行為太一致了。`,
    (s, t) => `${s}: I just want to help the team find the truth.||${s}：我只是想幫大家找出真相。`,
    (s, t) => `${s}: Let me share my analysis — ${t} has been helpful, probably blue.||${s}：讓我分享我的分析，${t} 一直在幫忙，應該是藍方。`,
  ],
  // Advanced: Role claiming system
  roleClaim: {
    blueClaim: [
      (s, role, roleZh) => `${s}: I'm the ${role}, don't vote me!||${s}：我是${roleZh}，別投我！`,
      (s, role, roleZh) => `${s}: I need to reveal — I'm the ${role}.||${s}：我必須公開了，我是${roleZh}。`,
    ],
    redFakeClaim: [
      (s, role, roleZh) => `${s}: I'm the ${role}, trust me.||${s}：我是${roleZh}，相信我。`,
      (s, role, roleZh) => `${s}: I haven't said this before, but I'm the ${role}.||${s}：我之前沒說過，但我是${roleZh}。`,
    ],
    challenge: [
      (s, t, role, roleZh) => `${s}: ${t} can't be the ${role} — I'm the ${role}!||${s}：${t} 不可能是${roleZh}，我才是${roleZh}！`,
      (s, t, role, roleZh) => `${s}: I don't believe ${t}'s claim, it's suspicious.||${s}：我不相信 ${t} 的宣告，很可疑。`,
    ],
    support: [
      (s, t, role, roleZh) => `${s}: I believe ${t}'s claim, their behavior matches.||${s}：我相信 ${t} 的宣告，行為吻合。`,
      (s, t, role, roleZh) => `${s}: ${t} is probably telling the truth about being ${role}.||${s}：${t} 說自己是${roleZh}應該是真的。`,
    ],
  },
  // Advanced: Self-defense when accused
  selfDefense: [
    (s, accuser) => `${s}: ${accuser}, you're wrong about me. I've been helping the team.||${s}：${accuser}，你搞錯了，我一直在幫大家。`,
    (s, accuser) => `${s}: ${accuser}, look at my actions — I've been helping the team.||${s}：${accuser}，看看我的行為，我一直在幫大家。`,
    (s, accuser) => `${s}: ${accuser}, if I was the killer, why would I speak up?||${s}：${accuser}，如果我是殺手，我為什麼要發言？`,
    (s, accuser) => `${s}: ${accuser}, stop pointing fingers without evidence!||${s}：${accuser}，沒證據別亂指！`,
    (s, accuser) => `${s}: ${accuser}, you're deflecting — maybe YOU should be investigated.||${s}：${accuser}，你在轉移焦點吧？也許該查的是你。`,
  ],
  // Advanced: Police timed reveal — RED result
  policeRevealRed: [
    (s, t) => `${s}: I've been waiting for the right time — ${t} is RED.||${s}：我等到了正確時機，${t} 是紅方。`,
    (s, t) => `${s}: ${t} is confirmed red, we need to vote them out now.||${s}：${t} 確認是紅方，必須馬上投掉。`,
  ],
  // Advanced: Police timed reveal — BLUE result
  policeRevealBlue: [
    (s, t) => `${s}: I'll reveal now: ${t} is confirmed blue, protect them.||${s}：我現在公開：${t} 確認是藍方，保護他。`,
    (s, t) => `${s}: I checked ${t}, they're clean — don't vote them.||${s}：我查了 ${t}，他是好人，別投他。`,
  ],
  // Advanced: Police urgent self-reveal
  policeUrgentReveal: [
    (s) => `${s}: I'm the police. I'm revealing now because I might not survive tonight.||${s}：我是警察。我現在公開因為我可能活不過今晚。`,
  ],
  policeDeathDump: [
    (s, info) => `${s}: Before I die — here's everything I know: ${info}||${s}：在我死之前，這是我知道的一切：${info}`,
  ],
};

export const FACTION_CHAT = {
  killer: {
    // Discuss who to kill tonight
    targetPlan: [
      (s, t) => `${s}: Let's go for ${t} tonight.||${s}：今晚殺 ${t} 吧。`,
      (s, t) => `${s}: I think we should take out ${t}.||${s}：我覺得該除掉 ${t}。`,
      (s, t) => `${s}: ${t} is getting dangerous, target them.||${s}：${t} 越來越危險了，鎖定他。`,
    ],
    // Warn about threats
    threat: [
      (s, t) => `${s}: Watch out for ${t}, they might be police.||${s}：小心 ${t}，可能是警察。`,
      (s, t) => `${s}: ${t} is asking too many questions...||${s}：${t} 問太多問題了⋯`,
      (s, t) => `${s}: I think ${t} is onto us.||${s}：我覺得 ${t} 懷疑我們了。`,
    ],
    // Coordinate voting strategy
    voteStrategy: [
      (s, t) => `${s}: Vote separately today, don't all target the same person.||${s}：今天分散投票，別都投同一個人。`,
      (s, t) => `${s}: Let's frame ${t} in chat and vote them out.||${s}：白天帶風向指控 ${t}，把他投出去。`,
      (s, t) => `${s}: If they suspect one of us, the others should defend.||${s}：如果有人被懷疑，其他人幫忙辯護。`,
    ],
    // React to events
    react: [
      (s) => `${s}: We need to be careful, they're getting close.||${s}：要小心了，他們越來越接近真相。`,
      (s) => `${s}: Good, that went well last night.||${s}：不錯，昨晚很順利。`,
      (s) => `${s}: Things are getting tight, stay calm.||${s}：局勢越來越緊，大家冷靜。`,
    ],
    reactTargeted: [
      (s, t) => `${s}: ${t} is protected, don't waste a kill on them.||${s}：${t} 有人保護，別浪費機會。`,
      (s, t) => `${s}: Keep an eye on ${t}, they might be onto us.||${s}：注意 ${t}，他可能發現我們了。`,
    ],
    // Avoid doctor
    exploitSaved: [
      (s, t) => `${s}: ${t} was saved — hit them again, doctor can't risk overdose.||${s}：${t} 被救了，再打一次，醫生不敢連保。`,
      (s, t) => `${s}: Attack ${t} again — the doctor has to switch or overdose them.||${s}：再殺 ${t}，醫生必須換人否則會過量致死。`,
    ],
  },
  police: {
    // Share investigation results — split by actual result
    shareIntelRed: [
      (s, t) => `${s}: I checked ${t}, they're RED.||${s}：我查了 ${t}，是紅方。`,
      (s, t) => `${s}: Investigation result: ${t} is red, confirmed.||${s}：查驗結果：${t} 是紅方，確認了。`,
    ],
    shareIntelBlue: [
      (s, t) => `${s}: ${t} is confirmed blue, they're clean.||${s}：${t} 確認是藍方，沒問題。`,
      (s, t) => `${s}: I checked ${t}, they're on our side.||${s}：我查了 ${t}，是我們這邊的。`,
    ],
    shareIntelSuspect: [
      (s, t) => `${s}: Investigation result: ${t} is suspicious.||${s}：查驗結果：${t} 有嫌疑。`,
      (s, t) => `${s}: I have a bad feeling about ${t}, worth investigating.||${s}：我對 ${t} 有不好的預感，值得查。`,
    ],
    // Discuss who to investigate
    investigatePlan: [
      (s, t) => `${s}: Let's check ${t} tonight.||${s}：今晚查 ${t} 吧。`,
      (s, t) => `${s}: We should investigate ${t}, they've been quiet.||${s}：應該查查 ${t}，他一直很安靜。`,
      (s, t) => `${s}: ${t} voted strangely, worth checking.||${s}：${t} 投票很奇怪，值得查。`,
    ],
    // Coordinate vote
    voteCoordinate: [
      (s, t) => `${s}: We all vote ${t} today, agreed?||${s}：今天大家都投 ${t}，同意嗎？`,
      (s, t) => `${s}: Focus fire on ${t}, don't split votes.||${s}：集火投 ${t}，別分散。`,
      (s, t) => `${s}: Let's not reveal too much in public chat about ${t}.||${s}：關於 ${t} 的事公開別透露太多。`,
    ],
    // Analysis — targeted (2-arg)
    analysis: [
      (s, t) => `${s}: ${t} defended a known red last round.||${s}：${t} 上回合幫已知紅方說話。`,
      (s, t) => `${s}: ${t} keeps voting with the killers.||${s}：${t} 一直跟殺手投一樣的人。`,
    ],
    // Analysis — general (1-arg)
    analysisGeneral: [
      (s) => `${s}: We're losing people, need to be more aggressive.||${s}：我們一直在死人，要積極一點。`,
      (s) => `${s}: Who should we protect tonight?||${s}：今晚要保護誰？`,
    ],
  },
  grudge: {
    // Discuss judgment target
    judgePlan: [
      (s, t) => `${s}: Let's judge ${t}, I think they're red.||${s}：審判 ${t} 吧，我覺得他是紅方。`,
      (s, t) => `${s}: Don't judge ${t}, might be civilian — dangerous for us.||${s}：別審判 ${t}，可能是平民，會害到我們。`,
      (s, t) => `${s}: ${t} is worth judging, could reveal useful info.||${s}：${t} 值得審判，可能有有用的情報。`,
    ],
    // Berserk coordination — targeted (2-arg)
    berserkPlan: [
      (s, t) => `${s}: We're berserk now. Target ${t}.||${s}：我們狂暴了，鎖定 ${t}。`,
      (s, t) => `${s}: Let's hunt down ${t} tonight.||${s}：今晚獵殺 ${t}。`,
    ],
    // Berserk coordination — general (1-arg)
    berserkPlanGeneral: [
      (s) => `${s}: Focus on one faction, don't split.||${s}：專注打一個陣營，別分散。`,
      (s) => `${s}: We're berserk, let's not waste this chance.||${s}：狂暴了，別浪費這次機會。`,
    ],
    // Survival strategy
    survival: [
      (s) => `${s}: We need to stay alive, be careful with judgments.||${s}：我們要活下去，審判要謹慎。`,
      (s) => `${s}: If we judge wrong, one of us dies.||${s}：如果審判錯了，我們會死一個。`,
      (s) => `${s}: Let's lay low in public and not draw attention.||${s}：公開場合低調點，別引起注意。`,
    ],
  },
};

export const NIGHT_FACTION_CHAT = {
  killer: {
    planKill: [
      (s, t) => `${s}: Kill ${t} tonight, they're the biggest threat.||${s}：今晚殺 ${t}，他威脅最大。`,
      (s, t) => `${s}: ${t} is exposed, let's finish them off.||${s}：${t} 暴露了，解決掉他。`,
      (s, t) => `${s}: I'll handle ${t} tonight.||${s}：今晚我來處理 ${t}。`,
      (s, t) => `${s}: Let's take out ${t} before they expose us.||${s}：趁 ${t} 揭發我們之前先下手。`,
    ],
    // First night only — no references to past behavior
    planKillFirstNight: [
      (s, t) => `${s}: Let's start with ${t}, take them out first.||${s}：先從 ${t} 下手吧。`,
      (s, t) => `${s}: I'll go for ${t} tonight, see how it goes.||${s}：今晚先殺 ${t}，看看情況。`,
      (s, t) => `${s}: ${t} might be police, let's hit them first.||${s}：${t} 可能是警察，先殺他。`,
    ],
    exploitSavedNight: [
      (s, t) => `${s}: ${t} was saved — attack again, doctor risks overdose if they repeat.||${s}：${t} 被救了，再殺一次，醫生連保會過量。`,
      (s, t) => `${s}: Hit ${t} again tonight — doctor can't afford to protect twice.||${s}：今晚再打 ${t}，醫生不敢連續保。`,
      (s, t) => `${s}: ${t} survived, but the doctor is in a bind now. Go again.||${s}：${t} 沒死，但醫生現在進退兩難。再打一次。`,
    ],
    tomorrowPlan: [
      (s, t) => `${s}: After the kill, we frame ${t} tomorrow in chat.||${s}：殺完之後，明天帶風向指控 ${t}。`,
      (s, t) => `${s}: Tomorrow let's push suspicion toward ${t}.||${s}：明天把嫌疑引向 ${t}。`,
    ],
    tomorrowPlanGeneral: [
      (s) => `${s}: Stay calm tomorrow, vote separately.||${s}：明天保持冷靜，分散投票。`,
      (s) => `${s}: If one of us gets suspected, the others play dumb.||${s}：如果有人被懷疑，其他人裝傻。`,
    ],
    urgency: [
      (s) => `${s}: We're running out of time, need big kills now.||${s}：時間不多了，必須殺關鍵的人。`,
      (s) => `${s}: They're closing in, pick carefully tonight.||${s}：他們快查到了，今晚要選好目標。`,
      (s) => `${s}: Only a few rounds left, make this count.||${s}：剩沒幾回合了，要殺對人。`,
    ],
  },
  police: {
    planInvestigate: [
      (s, t) => `${s}: I'll investigate ${t} tonight, they're suspicious.||${s}：今晚我查 ${t}，他很可疑。`,
      (s, t) => `${s}: ${t} has been too quiet, checking them tonight.||${s}：${t} 太安靜了，今晚查他。`,
      (s, t) => `${s}: Let me verify ${t}, their voting is off.||${s}：讓我驗一下 ${t}，他的投票很奇怪。`,
      (s, t) => `${s}: Focus on ${t} tonight, could be a killer.||${s}：今晚查 ${t}，可能是殺手。`,
    ],
    // First night only — no references to past behavior
    planInvestigateFirstNight: [
      (s, t) => `${s}: Let's check ${t} first, I have a hunch.||${s}：先查 ${t} 吧，我有預感。`,
      (s, t) => `${s}: I'll investigate ${t} tonight to start.||${s}：今晚先查 ${t}。`,
      (s, t) => `${s}: ${t} could be anyone, let me verify them.||${s}：${t} 什麼身分都有可能，讓我查查。`,
    ],
    shareResultRed: [
      (s, t) => `${s}: Last check confirmed ${t} is RED — be careful.||${s}：上次查驗確認 ${t} 是紅方，小心。`,
      (s, t) => `${s}: ${t} is confirmed red, we need to deal with them.||${s}：${t} 確認是紅方，必須處理。`,
    ],
    shareResultBlue: [
      (s, t) => `${s}: Good news, ${t} is blue. One less to worry about.||${s}：好消息，${t} 是藍方，少一個要擔心的。`,
      (s, t) => `${s}: ${t} is clean, I verified them already.||${s}：${t} 是好人，我已經查過了。`,
    ],
    protectAdvice: [
      (s, t) => `${s}: We should keep an eye on ${t}, they might be targeted.||${s}：注意 ${t}，他可能被殺手盯上了。`,
      (s, t) => `${s}: Hope the doctor protects ${t} tonight.||${s}：希望醫生今晚保 ${t}。`,
    ],
    protectAdviceFirstNight: [
      (s, t) => `${s}: Keep ${t} safe, they could be important.||${s}：保護好 ${t}，他可能很重要。`,
      (s, t) => `${s}: Let's hope ${t} survives the first night.||${s}：希望 ${t} 能撐過第一晚。`,
    ],
    protectAdviceGeneral: [
      (s) => `${s}: Stay safe tonight everyone, killers will be aggressive.||${s}：今晚大家小心，殺手會很積極。`,
      (s) => `${s}: We need to be careful, the killers are getting desperate.||${s}：要小心，殺手越來越急了。`,
    ],
    tomorrowPlan: [
      (s, t) => `${s}: If ${t} is red, we reveal them tomorrow and vote.||${s}：如果 ${t} 是紅方，明天就公開投他。`,
      (s, t) => `${s}: Tomorrow we push for voting out ${t}, everyone agree?||${s}：明天大家一起投 ${t}，同意嗎？`,
    ],
    tomorrowPlanGeneral: [
      (s) => `${s}: Let's coordinate tomorrow — don't split votes.||${s}：明天要協調好，別分散投票。`,
      (s) => `${s}: Stay focused tomorrow, we're making progress.||${s}：明天繼續專注，我們有進展了。`,
    ],
  },
  grudge: {
    planJudge: [
      (s, t) => `${s}: Let's judge ${t} tonight, I have a feeling.||${s}：今晚審判 ${t} 吧，我有預感。`,
      (s, t) => `${s}: ${t} is suspicious, worth judging tonight.||${s}：${t} 很可疑，今晚審他。`,
      (s, t) => `${s}: If we judge ${t} and they're red, we gain a lot.||${s}：如果審 ${t} 是紅方，我們賺到了。`,
    ],
    caution: [
      (s, t) => `${s}: Not sure about ${t}, maybe skip judging tonight.||${s}：不確定 ${t}，今晚或許別審判。`,
      (s, t) => `${s}: ${t} might be innocent, let's wait.||${s}：${t} 可能是無辜的，再等等。`,
    ],
    cautionGeneral: [
      (s) => `${s}: Be careful tonight, a wrong judgment kills one of us.||${s}：今晚小心，審判錯了我們要死人。`,
      (s) => `${s}: Let's observe one more round before judging.||${s}：再觀察一回合再審判吧。`,
    ],
    berserkHunt: [
      (s, t) => `${s}: We're berserk! Go for ${t} tonight!||${s}：狂暴了！今晚衝 ${t}！`,
      (s, t) => `${s}: Hunt ${t} down, no mercy.||${s}：追殺 ${t}，不留情。`,
    ],
    berserkHuntGeneral: [
      (s) => `${s}: Berserk mode — eliminate as many as we can!||${s}：狂暴模式，盡量多殺！`,
      (s) => `${s}: We're berserk — no holding back now!||${s}：狂暴了，不用再保留了！`,
    ],
  },
};

export const LAST_WORDS_TEMPLATES = {
  // Blue player dies — try to leave useful intel
  blueAccuse: [
    (name, t) => `Watch out for ${t}...||小心 ${t}⋯`,
    (name, t) => `I'm sure ${t} is the killer.||我確定 ${t} 是殺手。`,
    (name, t) => `${t} did this to me. Don't let them get away.||是 ${t} 害我的，別放過他。`,
    (name, t) => `Vote ${t} next, trust me.||下次投 ${t}，相信我。`,
    (name, t) => `I've been watching ${t}... they're not clean.||我一直在觀察 ${t}⋯他不乾淨。`,
  ],
  blueDefend: [
    (name, t) => `Protect ${t}, they're one of us.||保護 ${t}，他是自己人。`,
    (name, t) => `${t} is innocent, I'm certain.||${t} 是無辜的，我很確定。`,
    (name, t) => `Don't vote ${t}, they've been helping us.||別投 ${t}，他一直在幫我們。`,
  ],
  doctorDefend: [
    (name, t) => `I was protecting ${t} — keep them safe.||我一直在保護 ${t}，守好他。`,
    (name, t) => `${t} is important, I've been healing them. Don't let them die.||${t} 很重要，我一直在救他。別讓他死。`,
    (name, t) => `As the doctor, I trust ${t}. Protect them for me.||身為醫生，我信任 ${t}。替我保護他。`,
  ],
  blueGeneral: [
    (name) => `Don't trust the quiet ones...||別相信那些沉默的人⋯`,
    (name) => `Think carefully about who you trust.||想清楚你們該信任誰。`,
    (name) => `The truth will come out.||真相會大白的。`,
    (name) => `I did my best for the team.||我為大家盡力了。`,
  ],
  // Police dies — reveal confirmed RED
  policeRevealRed: [
    (name, t) => `I confirmed ${t} is RED!||我確認 ${t} 是紅方！`,
    (name, t) => `Police report: ${t} is RED. Vote them out!||警察報告：${t} 是紅方，投掉他！`,
  ],
  // Police dies — reveal confirmed BLUE
  policeRevealBlue: [
    (name, t) => `${t} is clean, I checked them. Protect them.||${t} 是好人，我查過了。保護他。`,
    (name, t) => `I verified ${t} — they're BLUE. Don't waste votes on them.||我查驗了 ${t}，是藍方。別浪費票在他身上。`,
  ],
  // Police dies — accuse suspicious target (no confirmed result)
  policeAccuse: [
    (name, t) => `My investigation points to ${t} — be careful.||我的調查指向 ${t}，小心他。`,
    (name, t) => `I'm sure ${t} is the killer.||我確定 ${t} 是殺手。`,
  ],
  // Red player dies — mislead or frame innocents
  redBluff: [
    (name, t) => `I know ${t} is the killer...||我知道 ${t} 是殺手⋯`,
    (name, t) => `${t} betrayed me.||${t} 出賣了我。`,
    (name, t) => `Look into ${t}, something's off.||去查 ${t} 吧，有問題。`,
    (name, t) => `Don't trust ${t}.||別相信 ${t}。`,
  ],
  redProtectAlly: [
    (name, t) => `${t} is definitely clean.||${t} 絕對沒問題。`,
    (name, t) => `I trust ${t} with my life.||我用命擔保 ${t}。`,
  ],
  redDeflect: [
    (name) => `I was wrongly accused...||我是被冤枉的⋯`,
    (name) => `You got the wrong person.||你們抓錯人了。`,
    (name) => `This was a mistake, you'll see.||這是個錯誤，你們會明白的。`,
    (name) => `I'm innocent...||我是無辜的⋯`,
  ],
  // Green player dies
  greenGrudge: [
    (name) => `You'll pay for this...||你們會付出代價的⋯`,
    (name) => `The beasts will avenge me.||怨獸們會替我報仇。`,
    (name, t) => `${t} will regret this.||${t} 會後悔的。`,
  ],
  greenZombie: [
    (name) => `The infection spreads...||感染在蔓延⋯`,
    (name) => `It's too late to stop it.||已經來不及阻止了。`,
  ],
  // Generic (any role, low-info fallback)
  generic: [
    (name) => `...||⋯`,
    (name) => `Good luck everyone.||大家加油吧。`,
    (name) => `I have nothing to say.||我沒什麼好說的。`,
  ],
};
