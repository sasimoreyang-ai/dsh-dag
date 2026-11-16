/**
 * LLMCompiler prompts, ported from `third_party/LLMCompiler`
 * (`src/llm_compiler/planner.py`, `configs/parallelqa/gpt_prompts.py`) and from
 * the dsh ParallelQA demo engine (`dsh-demo/engine.mjs`).
 *
 * The default tool vocabulary reproduces the ParallelQA arm verbatim, so the
 * planner and joiner prompts are byte-identical to the reference run unless the
 * caller overrides `tools`, `joinerPrompt`, or `plannerPrompt`.
 */

export const END_OF_PLAN = '<END_OF_PLAN>'
export const JOINNER_FINISH = 'Finish'
export const JOINNER_REPLAN = 'Replan'

/** One planner-visible tool: name, description block, and positional parameters. */
export interface ToolSpec {
  /** Registry tool name, written by the planner as `name(...)`. */
  name: string
  /** Description block placed in the planner system prompt, verbatim. */
  description: string
  /** Positional argument names in call order; surplus arguments are ignored. */
  parameters: string[]
  /**
   * `string` (default) coerces every positional scalar — and every element of an
   * array argument — to text, which is what the reference engine did before
   * building tool arguments. `raw` passes parsed values through unchanged.
   */
  coerce?: 'string' | 'raw'
}

/** `llm_compiler/constants: JOIN_DESCRIPTION`. */
const JOIN_DESCRIPTION = [
  'join():',
  ' - Collects and combines results from prior actions.',
  ' - A LLM agent is called upon invoking join to either finalize the user query or wait until the plans are executed.',
  ' - join should always be the last action in the plan, and will be called in two scenarios:',
  '   (a) if the answer can be determined by gathering the outputs from tasks to generate the final response.',
  '   (b) if the answer cannot be determined in the planning phase before you execute the plans. ',
].join('\n')

/** `configs/parallelqa/tools.py` — search description, verbatim. */
const SEARCH_DESCRIPTION = [
  'search(entity: str) -> str:',
  ' - Executes an exact search for the entity on Wikipedia.',
  ' - Returns the first paragraph if the entity is found.',
].join('\n')

/** `configs/parallelqa/tools.py: _MATH_DESCRIPTION` — first seven lines verbatim. */
const MATH_DESCRIPTION = [
  'math(problem: str, context: Optional[list[str]]) -> float:',
  ' - Solves the provided math problem.',
  ' - `problem` can be either a simple math problem (e.g. "1 + 3") or a word problem (e.g. "how many apples are there if there are 3 apples and 2 apples").',
  ' - You cannot calculate multiple expressions in one call. For instance, `math(\'1 + 3, 2 + 4\')` does not work. '
  + 'If you need to calculate multiple expressions, you need to call them separately like `math("1 + 3")` and then `math("2 + 4")`',
  ' - Minimize the number of `math` actions as much as possible. For instance, instead of calling '
  + '2. math("what is the 10% of $1") and then call 3. math("$1 + $2"), '
  + 'you MUST call 2. math("what is the 110% of $1") instead, which will reduce the number of math actions.',
  ' - You can optionally provide a list of strings as `context` to help the agent solve the problem. '
  + 'If there are multiple contexts you need to answer the question, you can provide them as a list of strings.',
  ' - `math` action will not see the output of the previous actions unless you provide it as `context`. '
  + 'You MUST provide the output of the previous actions as `context` if you need to do math on it. ',
  ' - You MUST NEVER provide `search` action\'s outputs as a variable in the `problem` argument. '
  + 'This is because `search` returns a text blob that contains the information about the entity, not a number or value. '
  + 'Therefore, when you need to provide an output of `search` action, you MUST provide it as a `context` argument to `math` action. '
  + 'For example, 1. search("Barack Obama") and then 2. math("age of $1") is NEVER allowed. '
  + 'Use 2. math("age of Barack Obama, context=["$1"]) instead.',
  ' - When you ask a question about `context`, specify the units. '
  + 'For instance, "what is xx in height?" or "what is xx in millions?" instead of "what is xx?"',
].join('\n')

/** `configs/parallelqa/gpt_prompts.py: PLANNER_PROMPT` — the five examples verbatim. */
export const PLANNER_EXAMPLES = [
  'Question: If cheetah was 1.3 times slower, greyhound was 1.5 times faster, and falcon was 2.3 time slower then their maximum speeds, what will be the ratio of the fastest animal to the slowest animal?',
  '1. search("cheetah")',
  '2. math("cheetah max speed in km/h if 1.3 times slower?", ["$1"]',
  '3. search("greyhound")',
  '4. math("greyhound max speed in km/h if 1.5 times faster?", ["$3"]',
  '5. search("falcon")',
  '6. math("falcon max speed in km/h if 2.3 times slower?", ["$5"]',
  '7. math("max($2, $4, $6) / min($2, $4, $6)")',
  'Thought: I can answer the question now.',
  `8. join()${END_OF_PLAN}`,
  '###',
  '',
  'Question: If Mount Everest\'s height were halved and Mount Kilimanjaro\'s height were doubled, what would be the difference in their height?',
  "1. search('Mount Everest')",
  '2. math("half of Mount Everest height in meter?", ["$1"])',
  '3. search("Mount Kilimanjaro")',
  '4. math("double of Mount Kilimanjaro height in meter?", ["$3"])',
  '5. math("abs($3 - $4)")',
  'Thought: I can answer the question now.',
  `6. join()${END_OF_PLAN}`,
  '###',
  '',
  'Question: With the Sahara Desert\'s area reduced by 33% and the Kalahari Desert\'s area magnified by 52%, which one covers more ground?',
  "1. search('Sahara Desert')",
  "2. math('Sahara Desert area in km^2 if reduced by 33%?', ['$1'])",
  '3. search("Kalahari Desert")',
  "4. math('Kalahari Desert area in km^2 if magnified by 52%?', ['$3'])",
  'Thought: I can compare the numbers without calling math.',
  `5. join()${END_OF_PLAN}`,
  '###',
  '',
  'Question: Determine the smaller value: the depth difference in meters between the Mariana Trench and the Puerto Rico Trench, or the depth difference in meters between the South Sandwich Trench and the Sunda Trench.',
  "1. search('Mariana Trench')",
  '2. search(\'Puerto Rico Trench\')',
  "3. math('absolute depth difference between Mariana and Puerto Rico Trench in meters?', ['$1', '$2'])",
  '4. search(\'South Sandwich Trench\')',
  '5. search(\'Sunda Trench\')',
  "6. math('absolute depth difference between South Sandwich and Sunda Trench in meters?', ['$4', '$5'])",
  "7. math('min($3, $6)')",
  'Thought: I can answer the question now.',
  `8. join()${END_OF_PLAN}`,
  '###',
  '',
  'Question: What is the raio of the height of Mount Everest and the height of Mount Kilimanjaro?',
  "1. search('Mount Everest')",
  "2. search('Mount Kilimanjaro')",
  "3. math('height of Mount Everest / height of Mount Kilimanjaro', ['$1', '$2'])",
  'Thought: I can answer the question now.',
  `4. join()${END_OF_PLAN}`,
  '###',
  '',
].join('\n')

/** `configs/parallelqa/gpt_prompts.py: OUTPUT_PROMPT` verbatim (the joiner system prompt). */
export const JOINER_PROMPT = [
  'Solve a question answering task with interleaving Observation, Thought, and Action steps. '
  + 'Answer should always be a single item and MUST not be multiple choices.',
  'Thought step can reason about the observations in a few words. You MUST keep it short.',
  'Action can be only one type:'
  + ` (1) ${JOINNER_FINISH}(answer): returns the answer and finishes the task. `
  + '    - Final answer MUST NOT contain any description, and must be short (e.g. Yes/No, numbers, entity names, etc.)',
  '    - When you are asked for differences, you consider the absolute value of the difference.',
  '    - If you are asked about a value (e.g. ratio, difference, average, ...), it has to be a number, not a description. '
  + 'For instance, when you are asked about the ratio of the height of Mount Everest and the height of Mount Kilimanjaro, you must '
  + 'return the ratio (e.g. 1.2), not the name of the mountain (e.g. Mount Everest to Mount Kilimanjaro).',
  '',
  'Here are some examples:',
  '',
  '',
].join('\n')
  + [
    'Question: If cheetah was 1.3 times slower, and greyhound was 1.5 times faster, which animal was faster?',
    'search(cheetah)',
    'Observation: The cheetah (Acinonyx jubatus) is a large cat with a tawny to creamy white or pale buff fur that is marked with evenly spaced, solid black spots. Its head is small and rounded, with a short snout and black tear-like facial streaks. It reaches 67–94 cm (26–37 in) at the shoulder, and the head-and-body length is between 1.1 and 1.5 m (3 ft 7 in and 4 ft 11 in). Adults weigh between 21 and 72 kg (46 and 159 lb). It is the fastest land animal, capable of running at 80 to 98 km/h (50 to 61 mph); it has evolved specialized adaptations for speed, including a light build, long thin legs, and a long tail..',
    'search(greyhound)',
    'Observation: The English Greyhound, or simply the Greyhound, is a breed of dog, a sighthound which has been bred for coursing, greyhound racing and hunting. Since the rise in large-scale adoption of retired racing Greyhounds, the breed has seen a resurgence in popularity as a family pet.. Greyhounds are defined as a tall, muscular, smooth-coated, "S-shaped" type of sighthound with a long tail and tough feet. Greyhounds are a separate breed from other related sighthounds, such as the Italian greyhound.[2][3]. The Greyhound is a gentle and intelligent breed whose combination of long, powerful legs, deep chest, flexible spine, and slim build allows it to reach average race speeds exceeding 64 kilometres per hour (40 mph).[4][5][6] The Greyhound can reach a full speed of 70 kilometres per hour (43 mph) within 30 metres (98 ft), or six strides from the boxes, traveling at almost 20 metres per second (66 ft/s) for the first 250 metres (820 ft) of a race.[7][8].',
    'math(what is the speed of cheetah in km/h if it was 1.3 times slower?)',
    'Observation: 61.53846153846154',
    'math(what is the speed of greyhound in km/h if it was 1.5 times faster?)',
    'Observation: 105',
    'Thought: Comparing the numbers, the greyhound was faster.',
    `Action: ${JOINNER_FINISH}(greyhound)`,
    '###',
    '',
    'Question: If Mount Everest\'s height were halved and Mount Kilimanjaro\'s height were doubled, what would be the difference in their height?',
    'search(Mount Everest)',
    'Observation: Mount Everest (Nepali: सगरमाथा, romanized: Sagarmāthā; Tibetan: Chomolungma ཇོ་མོ་གླང་མ; Chinese: 珠穆朗玛峰; pinyin: Zhūmùlǎngmǎ Fēng) is Earth\'s highest mountain above sea level, located in the Mahalangur Himal sub-range of the Himalayas. The China–Nepal border runs across its summit point.[2] Its elevation (snow height) of 8,848.86 m (29,031 ft 82 in) was most recently established in 2020 by the Chinese and Nepali authorities.[3][4]. Mount Everest attracts many climbers, including highly experienced mountaineers. There are two main climbing routes, one approaching the summit from the southeast in Nepal (known as the "standard route") and the other from the north in Tibet. While not posing major technical climbing challenges on the standard route, Everest presents dangers such as altitude sickness, cold, and wind, as well as hazards from avalanches and the Khumbu Icefall.',
    'search(Mount Kilimanjaro)',
    'Observation: Mount Kilimanjaro (/ˌkɪlɪmənˈdʒɑːroʊ/)[4] is a dormant volcano located in Kilimanjaro Region of Tanzania. It has three volcanic cones: Kibo, Mawenzu, and Shira. It is the highest mountain in Africa and the highest single free-standing mountain above sea level in the world: 5,895 m (19,341 ft) above sea level and about 4,900 m (16,100 ft) above its plateau base. It is the highest volcano in Africa and the Eastern Hemisphere.. Kilimanjaro is the fourth most topographically prominent peak on Earth.',
    'math(what is the half of the height of Mount Everest in meter?)',
    'Observation: 4444.43',
    'math(what is the double of the height of Mount Kilimanjaro in meter?)',
    'Observation: 11790',
    'math(abs(4444.43 - 11790))',
    'Observation: 7345.57',
    'Thought: Difference in their height is 7345.57.',
    `Action: ${JOINNER_FINISH}(7345.57)`,
    '###',
    '',
    'Question: With the Sahara Desert\'s area reduced by 33% and the Kalahari Desert\'s area magnified by 52%, which one covers more ground?',
    'search(Sahara Desert)',
    'Observation: The Sahara (/səˈhɑːrə/, /səˈhærə/) is a desert spanning North Africa. With an area of 9,200,000 square kilometres (3,600,000 sq mi), it is the largest hot desert in the world and the third-largest desert overall, smaller only than the deserts of Antarctica and the northern Arctic.[1][2][3]. The name "Sahara" is derived from the Arabic word for "desert" in the feminine irregular form, the singular ṣaḥra\' (صحراء /ˈsˤaħraʔ/), plural ṣaḥārā (صَحَارَى, /ˈsˤaħaːraʔ/),[4][5][6][7] ṣaḥār (صَحَار), ṣaḥrāwāt (صَحْرَاوَات).[8]. The desert covers much of North Africa, excluding the fertile region on the Mediterranean Sea coast, and the Atlas Mountains of the Maghreb, and the Nile Valley in Egypt and the Sudan.[9] It stretches from the Red Sea in the east and the Mediterranean in the north to the Atlantic in the west, where the landscape gradually changes from sandy hammada ergs to gravel plains.',
    'search(Kalahari Desert)',
    'Observation: The Kalahari Desert is a large semi-arid sandy savanna in Southern Africa extending for 900,000 square kilometres (350,000 sq mi), covering much of Botswana, as well as parts of Namibia and South Africa.. It is not to be confused with the Angolan, Namibian, and South African Namib coastal desert, whose name is of Khoekhoegowab origin and means "vast place".. Kalahari is derived from the Tswana word Kgala, meaning "the great thirst", or Kgalagadi, meaning "a waterless place";[1] the Kalahari has vast areas covered by red sand without any permanent surface water.. The Kalahari Desert was not always a dry desert. The fossil flora and fauna from Gcwihaba Cave in Botswana indicates that the region was much wetter and cooler at least from 30 to 11 thousand BP (before present), especially after 17,500 BP.[2].',
    'math(what the area of the Sahara Desert in km^2 if it was reduced by 33%?)',
    'Observation: 6164000',
    'math(what the area of the Kalahari Desert in km^2 if it was magnified by 52%?)',
    'Observation: 1368000',
    'Thought: Comparing the numbers, the Sahara Desert covers more ground.',
    `Action: ${JOINNER_FINISH}(Sahara Desert)`,
    '###',
    '',
    'Question: Determine the smaller value: the depth difference in meters between the Mariana Trench and the Puerto Rico Trench, or the depth difference in meters between the South Sandwich Trench and the Sunda Trench.',
    'search(Mariana Trench)',
    'Observation: The Mariana Trench is an oceanic trench located in the western Pacific Ocean, about 200 kilometres (124 mi) east of the Mariana Islands; it is the deepest oceanic trench on Earth. It is crescent-shaped and measures about 2,550 km (1,580 mi) in length and 69 km (43 mi) in width. The maximum known depth is 10,984 ± 25 metres (36,037 ± 82 ft; 6,006 ± 14 fathoms; 6.825 ± 0.016 mi) at the southern end of a small slot-shaped valley in its floor known as the Challenger Deep.[1] The deepest point of the trench is more than 2 km (1.2 mi) farther from sea level than the peak of Mount Everest.[a]. At the bottom of the trench, the water column above exerts a pressure of 1,086 bar (15,750 psi), more than 1,071 times the standard atmospheric pressure at sea level. At this pressure, the density of water is increased by 4.96%.',
    'search(Puerto Rico Trench)',
    'Observation: The Puerto Rico Trench is located on the boundary between the Caribbean Sea and the Atlantic Ocean. The oceanic trench, the deepest in the Atlantic, is associated with a complex transition between the Lesser Antilles subduction zone to the south and the major transform fault zone or plate boundary, which extends west between Cuba and Hispaniola through the Cayman Trough to the coast of Central America.. The trench is 800 kilometres (497 mi) long[1] and has a maximum depth of 8,376 metres (27,480 ft)[2] or 5.20 miles. This constitutes the single deepest point in the Atlantic Ocean. This point is commonly referred to as the Milwaukee Deep, with the Brownson Deep naming the seabed surrounding it.[3] However, more recently, the latter term has also been used interchangeably with the former to refer to this point.[4][5][6] The exact point was identified by the DSSV Pressure Drop using a state-of-the-art Kongsberg EM124 multibeam sonar in 2018, and directly visited and depth verified by the crewed submersible Deep-Submergence Vehicle DSV Limiting Factor (a Triton 36000/2 model submersible) piloted by Victor Vescovo.[7][8][9].',
    'math(what is the depth difference between the Mariana Trench and the Puerto Rico Trench in meters?)',
    'Observation: 2608',
    'search(South Sandwich Trench)',
    'Observation: 55°25′44″S 26°11′29″W / 55.42889°S 26.19139°W / -55.42889; -26.19139. The South Sandwich Trench is a deep arcuate trench in the South Atlantic Ocean lying 100 kilometres (62 mi) to the east of the South Sandwich Islands. It is the deepest trench of the Southern Atlantic Ocean, and the second deepest of the Atlantic Ocean after the Puerto Rico Trench. Since the trench extends south of the 60th parallel south, it also contains the deepest point in the Southern Ocean.. The deepest point in the entire trench is the Meteor Deep, whose location prior to February 2019 was identified as 55°25.12′S 26°24.28′W / 55.41867°S 26.40467°W / -55.41867; -26.40467 (Meteor Deep) at a depth of 8,202 metres (26,909 ft).',
    'search(Sunda Trench)',
    'Observation: The Sunda Trench, earlier known as and sometimes still indicated as the Java Trench,[1] is an oceanic trench located in the Indian Ocean near Sumatra, formed where the Australian-Capricorn plates subduct under a part of the Eurasian Plate. It is 3,200 kilometres (2,000 mi) long with a maximum depth of 7,290 metres (23,920 feet).[2] Its maximum depth is the deepest point in the Indian Ocean. The trench stretches from the Lesser Sunda Islands past Java, around the southern coast of Sumatra on to the Andaman Islands, and forms the boundary between Indo-Australian Plate and Eurasian plate. The trench is considered to be part of the Pacific Ring of Fire.. In 2005, scientists found evidence that the 2004 earthquake activity in the area of the Java Trench could lead to further catastrophic shifting within a relatively short period of time, perhaps less than a decade.[3] This threat has resulted in international agreements to establish a tsunami warning system in place along the Indian Ocean coast.',
    'math(what is the depth difference between the South Sandwich Trench and the Sunda Trench in meters?)',
    'Observation: 912',
    'math(min(2608, 912))',
    'Observation: 912',
    'Thought: The smaller depth difference is 912',
    `Action: ${JOINNER_FINISH}(912)`,
    '',
  ].join('\n')

/**
 * The ParallelQA tool vocabulary, mirroring `configs/parallelqa/tools.py`.
 * @returns fresh specs so a caller may mutate its own copy.
 */
export function defaultTools(): ToolSpec[] {
  return [
    { name: 'search', description: SEARCH_DESCRIPTION, parameters: ['entity'] },
    { name: 'math', description: MATH_DESCRIPTION, parameters: ['problem', 'context'] },
  ]
}

/**
 * Build LLMCompiler's planner system prompt
 * (`planner.py: generate_llm_compiler_prompt`).
 *
 * The action count in the header keeps upstream's off-by-one — the listed
 * actions are the caller's tools plus `join`, and the header announces one more.
 * @param tools - planner-visible tools in listing order.
 * @param isReplan - whether the prompt is for a replan round.
 * @returns the system prompt text.
 */
export function plannerSystemPrompt(tools: readonly ToolSpec[], isReplan: boolean): string {
  const actions = tools.map((tool, index) => `${index + 1}. ${tool.description}\n`)
  const joinIndex = tools.length + 1
  const prefix = [
    'Given a user query, create a plan to solve it with the utmost parallelizability. '
    + `Each plan should comprise an action from the following ${tools.length + 2} types:\n`,
    ...actions,
    `${joinIndex}. ${JOIN_DESCRIPTION}\n\n`,
    'Guidelines:\n',
    ' - Each action described above contains input/output types and description.\n',
    '    - You must strictly adhere to the input and output types for each action.\n',
    '    - The action descriptions contain the guidelines. You MUST strictly follow those guidelines when you use the actions.\n',
    ' - Each action in the plan should strictly be one of the above types. Follow the Python conventions for each action.\n',
    ' - Each action MUST have a unique ID, which is strictly increasing.\n',
    ' - Inputs for actions can either be constants or outputs from preceding actions. '
    + 'In the latter case, use the format $id to denote the ID of the previous action whose output will be the input.\n',
    ` - Always call join as the last action in the plan. Say '${END_OF_PLAN}' after you call join\n`,
    ' - Ensure the plan maximizes parallelizability.\n',
    ' - Only use the provided action types. If a query cannot be addressed using these, invoke the join action for the next steps.\n',
    ' - Never explain the plan with comments (e.g. #).\n',
    ' - Never introduce new actions other than the ones provided.\n\n',
  ].join('')
  const replan = isReplan
    ? [
      ' - You are given "Previous Plan" which is the plan that the previous agent created along with the execution results (given as Observation) of each plan and a general thought (given as Thought) about the executed results.',
      'You MUST use these information to create the next plan under "Current Plan".',
      ' - When starting the Current Plan, you should start with "Thought" that outlines the strategy for the next plan.',
      ' - In the Current Plan, you should NEVER repeat the actions that are already executed in the Previous Plan.\n\n',
    ].join('')
    : ''
  return `${prefix}${replan}Here are some examples:\n\n${PLANNER_EXAMPLES}`
}
