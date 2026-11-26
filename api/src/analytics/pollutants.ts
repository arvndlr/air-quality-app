import { categoryFor, subIndex, type AqiPollutant, type CategoryInfo } from "./denr.js";

export type PollutantKey = "pm25" | "pm10" | "so2" | "co" | "no2" | "co2" | "voc" | "nh3";

export const POLLUTANT_KEYS: PollutantKey[] = ["pm25", "pm10", "so2", "co", "no2", "co2", "voc", "nh3"];

/**
 * How a pollutant's index is derived:
 * - denr: official DENR-EMB AQI breakpoints, from a calibrated sensor.
 * - denr-estimated: DENR breakpoints, but the reading is estimated by the uncalibrated MiCS-6814.
 * - guideline: no AQI breakpoints; the index is the percentage of the 24-hour guideline value.
 * - indicator: not a criteria pollutant; guidance-based bands used only for comfort and ventilation.
 */
export type IndexBasis = "denr" | "denr-estimated" | "guideline" | "indicator";

export type Guideline = { period: "1-hour" | "8-hour" | "24-hour" | "annual"; value: number; unit: string; source: string };

/** Content tier used for health effects and recommendations. */
export type Tier = "fair" | "usg" | "very-unhealthy" | "severe";

export function tierFor(category: CategoryInfo | null): Tier | null {
  if (!category) return null;
  switch (category.key) {
    case "good":
      return null;
    case "fair":
      return "fair";
    case "usg":
      return "usg";
    case "very-unhealthy":
      return "very-unhealthy";
    default:
      return "severe";
  }
}

type TierText = Record<Tier, string[]>;

export type PollutantDef = {
  key: PollutantKey;
  label: string;
  unit: string;
  basis: IndexBasis;
  /** Averaging period whose average sets the DENR sub-index. */
  aqiPeriod: "24h" | "8h";
  aqiPollutant?: AqiPollutant;
  /** How the annual mean is formed from quarterly means (DENR manual §1.3–1.4). */
  annualMean: "geometric" | "arithmetic";
  guidelines: Guideline[];
  /** Typical local sources, used when the data alone can't narrow the cause down. */
  sources: string[];
  healthEffects: TierText;
  affectedGroups: string[];
  whatToDo: TierText;
  menroActions: string[];
};

const NAAQGV = "DENR NAAQGV (DAO 2000-81, DAO 2013-13)";

export const POLLUTANTS: Record<PollutantKey, PollutantDef> = {
  pm25: {
    key: "pm25",
    label: "PM2.5",
    unit: "µg/m³",
    basis: "denr",
    aqiPeriod: "24h",
    aqiPollutant: "pm25",
    annualMean: "geometric",
    guidelines: [
      { period: "24-hour", value: 50, unit: "µg/Ncm", source: NAAQGV },
      { period: "annual", value: 25, unit: "µg/Ncm", source: NAAQGV }
    ],
    sources: [
      "Vehicle exhaust, especially diesel jeepneys, trucks and tricycles",
      "Open burning of garbage, leaves or crop residue",
      "Cooking with wood or charcoal and other household burning",
      "Industrial combustion and power generation",
      "Smoke carried in from fires outside the area"
    ],
    healthEffects: {
      fair: ["Unusually sensitive people may notice coughing or throat irritation."],
      usg: [
        "Coughing, wheezing and asthma attacks",
        "Aggravated bronchitis and COPD",
        "Chest discomfort or palpitations in people with heart disease"
      ],
      "very-unhealthy": [
        "Breathing difficulty and reduced lung function, even in healthy adults",
        "More asthma attacks and emergency visits",
        "Higher risk of heart attack and stroke in people with heart disease"
      ],
      severe: [
        "Serious worsening of heart and lung disease",
        "Raised risk of heart attack, stroke and premature death",
        "Long-term exposure is linked to lung cancer and stunted lung growth in children"
      ]
    },
    affectedGroups: [
      "Children and older adults",
      "Pregnant women",
      "People with asthma, COPD or other lung disease",
      "People with heart disease or diabetes",
      "Outdoor workers, vendors, drivers and traffic enforcers"
    ],
    whatToDo: {
      fair: ["Sensitive people should shorten long or heavy outdoor exertion."],
      usg: [
        "Sensitive groups should limit outdoor activity",
        "Wear a well-fitted N95/KN95 mask outdoors",
        "Keep windows closed near traffic or smoke"
      ],
      "very-unhealthy": [
        "Everyone should reduce outdoor activity; sensitive groups should stay indoors",
        "Use a HEPA air purifier and keep doors and windows closed",
        "Avoid burning, frying or smoking indoors"
      ],
      severe: [
        "Everyone should stay indoors with windows and doors closed",
        "Postpone unnecessary trips and outdoor events",
        "Seek medical care for chest pain, breathlessness or palpitations"
      ]
    },
    menroActions: [
      "Inspect and stop open burning (RA 8749 §20, RA 9003)",
      "Coordinate traffic management and anti-smoke-belching checks with the PNP/LTO",
      "Check nearby industries and establishments for smoke emissions"
    ]
  },
  pm10: {
    key: "pm10",
    label: "PM10",
    unit: "µg/m³",
    basis: "denr",
    aqiPeriod: "24h",
    aqiPollutant: "pm10",
    annualMean: "geometric",
    guidelines: [
      { period: "24-hour", value: 150, unit: "µg/Ncm", source: NAAQGV },
      { period: "annual", value: 60, unit: "µg/Ncm", source: NAAQGV }
    ],
    sources: [
      "Road dust from unpaved or dusty roads",
      "Construction, demolition and earthmoving",
      "Quarrying, hauling of sand and gravel",
      "Wind-blown soil on dry, windy days",
      "Open burning (also raises PM2.5)"
    ],
    healthEffects: {
      fair: ["Mild eye, nose and throat irritation in sensitive people."],
      usg: ["Coughing, sneezing and sore throat", "Sinus congestion and eye irritation", "Asthma attacks and worsened bronchitis"],
      "very-unhealthy": [
        "Shortness of breath even in healthy people",
        "Serious aggravation of asthma and COPD",
        "Airway inflammation"
      ],
      severe: ["Severe breathing difficulty", "Hospital admissions for respiratory disease", "Aggravated heart disease"]
    },
    affectedGroups: [
      "People with asthma, bronchitis or allergies",
      "Children and older adults",
      "Construction and quarry workers",
      "Residents along dusty roads"
    ],
    whatToDo: {
      fair: ["Keep windows closed on dusty or windy days."],
      usg: ["Wear a dust mask (N95) outdoors", "Wet-mop instead of sweeping", "Rinse eyes and nose after exposure"],
      "very-unhealthy": [
        "Stay indoors and seal gaps around doors and windows",
        "Pause sweeping, hauling and other dust-raising work",
        "Sensitive groups should avoid outdoor activity"
      ],
      severe: [
        "Everyone should stay indoors",
        "Stop construction and quarry work nearby",
        "Seek medical help if breathing becomes difficult"
      ]
    },
    menroActions: [
      "Require dust control (water spraying, covered hauling) at construction and quarry sites",
      "Schedule road wetting or street cleaning on affected roads",
      "Inspect permits of nearby earthmoving and quarrying activities"
    ]
  },
  so2: {
    key: "so2",
    label: "SO2",
    unit: "ppb",
    basis: "denr",
    aqiPeriod: "24h",
    aqiPollutant: "so2",
    annualMean: "arithmetic",
    guidelines: [
      { period: "24-hour", value: 70, unit: "ppb (180 µg/Ncm)", source: NAAQGV },
      { period: "annual", value: 30, unit: "ppb (80 µg/Ncm)", source: NAAQGV }
    ],
    sources: [
      "Burning of sulfur-containing fuel (bunker oil, diesel, coal)",
      "Power plants and industrial boilers",
      "Ships and port activity",
      "Volcanic degassing from Taal Volcano when winds carry vog towards the area"
    ],
    healthEffects: {
      fair: ["People with asthma may notice chest tightness during exertion."],
      usg: [
        "Airway narrowing within minutes for people with asthma",
        "Wheezing, chest tightness and shortness of breath",
        "Eye, nose and throat irritation"
      ],
      "very-unhealthy": [
        "Asthma attacks needing medication",
        "Breathing difficulty in people with lung or heart disease",
        "Airway inflammation"
      ],
      severe: ["Severe asthma attacks that may need emergency care", "Breathing difficulty even in healthy people"]
    },
    affectedGroups: [
      "People with asthma (affected at much lower levels than others)",
      "Children and older adults",
      "People with heart or lung disease",
      "Outdoor workers"
    ],
    whatToDo: {
      fair: ["People with asthma should carry their reliever inhaler."],
      usg: [
        "People with asthma should limit outdoor exertion",
        "Keep windows closed near industrial or burning sources",
        "Watch PHIVOLCS advisories for Taal volcanic smog (vog)"
      ],
      "very-unhealthy": [
        "Stay indoors, away from industrial areas and exhaust",
        "Use reliever inhalers at the first symptoms",
        "Wear an N95 mask if you must go out"
      ],
      severe: [
        "Everyone should stay indoors with windows closed",
        "Seek emergency care for severe breathing difficulty"
      ]
    },
    menroActions: [
      "Check PHIVOLCS bulletins for Taal Volcano SO2 emission and vog advisories",
      "Inspect nearby industries burning fuel oil or coal",
      "Coordinate with DENR-EMB Region IV-A on industrial sources"
    ]
  },
  co: {
    key: "co",
    label: "CO",
    unit: "ppm",
    basis: "denr-estimated",
    aqiPeriod: "8h",
    aqiPollutant: "co",
    annualMean: "arithmetic",
    guidelines: [
      { period: "1-hour", value: 30, unit: "ppm (35 mg/Ncm)", source: NAAQGV },
      { period: "8-hour", value: 9, unit: "ppm (10 mg/Ncm)", source: NAAQGV }
    ],
    sources: [
      "Vehicle exhaust in congested traffic",
      "Idling vehicles and generators",
      "Open burning and charcoal cooking",
      "Poorly vented gas or LPG appliances near the sensor"
    ],
    healthEffects: {
      fair: ["Reduced exercise tolerance for people with heart disease."],
      usg: ["Chest pain (angina) in people with heart disease", "Headache and fatigue"],
      "very-unhealthy": ["Headache, dizziness and nausea", "Confusion and impaired judgement"],
      severe: ["Loss of consciousness", "Carbon monoxide poisoning, which can be fatal", "Harm to a developing foetus"]
    },
    affectedGroups: [
      "People with heart disease or anaemia",
      "Pregnant women and infants",
      "Older adults",
      "Drivers, traffic enforcers and vendors along busy roads"
    ],
    whatToDo: {
      fair: ["Avoid idling vehicles in enclosed spaces."],
      usg: ["People with heart disease should avoid heavy traffic areas", "Ventilate enclosed spaces with engines or stoves"],
      "very-unhealthy": [
        "Avoid heavy traffic areas",
        "Switch off fuel-burning appliances and engines indoors",
        "Move children, pregnant women and heart patients to fresh air"
      ],
      severe: ["Evacuate the area and get fresh air", "Call emergency services; oxygen treatment may be needed"]
    },
    menroActions: [
      "Coordinate traffic rerouting and anti-idling enforcement",
      "Inspect open burning and charcoal-making in the area",
      "Verify the reading with a calibrated CO monitor before a public advisory (sensor is estimated)"
    ]
  },
  no2: {
    key: "no2",
    label: "NO2",
    unit: "ppb",
    basis: "guideline",
    aqiPeriod: "24h",
    annualMean: "arithmetic",
    guidelines: [{ period: "24-hour", value: 80, unit: "ppb (150 µg/Ncm)", source: NAAQGV }],
    sources: [
      "Vehicle exhaust, especially diesel engines",
      "Power generation and industrial combustion",
      "Gas stoves and generators near the sensor"
    ],
    healthEffects: {
      fair: ["Airway irritation for people with asthma."],
      usg: ["Airway inflammation and coughing", "Asthma attacks, especially in children"],
      "very-unhealthy": ["Breathing difficulty and wheezing", "Lower resistance to respiratory infections"],
      severe: ["Serious breathing difficulty", "Higher risk of bronchitis and pneumonia"]
    },
    affectedGroups: ["Children", "People with asthma", "Older adults", "People living or working beside busy roads"],
    whatToDo: {
      fair: ["Sensitive people should avoid busy roads during rush hours."],
      usg: ["Limit time near heavy traffic", "Keep windows closed during rush hours"],
      "very-unhealthy": ["Stay indoors away from traffic", "Avoid indoor combustion such as gas stoves and generators"],
      severe: ["Everyone should stay indoors", "Seek medical care for breathing difficulty"]
    },
    menroActions: [
      "Coordinate traffic management on roads near the station",
      "Verify with a calibrated NO2 analyzer before a public advisory (sensor is estimated)"
    ]
  },
  co2: {
    key: "co2",
    label: "CO2",
    unit: "ppm",
    basis: "indicator",
    aqiPeriod: "24h",
    annualMean: "arithmetic",
    guidelines: [],
    sources: [
      "Crowded or poorly ventilated space around the sensor",
      "Combustion nearby (engines, burning, cooking)",
      "Plant respiration and calm air at night"
    ],
    healthEffects: {
      fair: ["Stuffy air and mild drowsiness."],
      usg: ["Headaches and drowsiness", "Poor concentration"],
      "very-unhealthy": ["Dizziness and restlessness", "Raised heart and breathing rate"],
      severe: ["Serious impairment at very high levels"]
    },
    affectedGroups: ["Students and office workers in crowded rooms", "People in poorly ventilated spaces"],
    whatToDo: {
      fair: ["Open a window or door."],
      usg: ["Increase ventilation", "Reduce crowding"],
      "very-unhealthy": ["Leave the room and get fresh air", "Check for combustion sources"],
      severe: ["Ventilate thoroughly before returning"]
    },
    menroActions: ["Check whether the sensor site is enclosed or near a combustion source"]
  },
  voc: {
    key: "voc",
    label: "VOC",
    unit: "index",
    basis: "indicator",
    aqiPeriod: "24h",
    annualMean: "arithmetic",
    guidelines: [],
    sources: ["Solvents, paint and fuel vapours", "Smoke from burning", "Cooking emissions", "Vehicle exhaust"],
    healthEffects: {
      fair: ["Faint chemical odour; mild irritation in sensitive people."],
      usg: ["Headaches, dizziness and fatigue", "Eye, nose and throat irritation"],
      "very-unhealthy": ["Nausea and triggered asthma or allergies"],
      severe: ["Possible liver, kidney or nervous system harm with repeated exposure"]
    },
    affectedGroups: ["People with asthma or chemical sensitivity", "Children", "Pregnant women"],
    whatToDo: {
      fair: ["Ventilate after painting, cleaning or cooking."],
      usg: ["Find and remove the source", "Open windows and run exhaust fans"],
      "very-unhealthy": ["Leave the area and ventilate it fully"],
      severe: ["Stop the activity producing the fumes", "Seek medical help for persistent symptoms"]
    },
    menroActions: ["Inspect nearby paint, solvent or fuel-handling activities"]
  },
  nh3: {
    key: "nh3",
    label: "NH3",
    unit: "ppm",
    basis: "indicator",
    aqiPeriod: "24h",
    annualMean: "arithmetic",
    guidelines: [],
    sources: ["Livestock and poultry farms", "Fertilizer application", "Garbage and wastewater", "Chemical leaks"],
    healthEffects: {
      fair: ["Noticeable pungent odour."],
      usg: ["Burning eyes, nose and throat", "Coughing"],
      "very-unhealthy": ["Chest tightness and chemical bronchitis"],
      severe: ["Fluid in the lungs at high concentrations", "Chemical burns to eyes and skin"]
    },
    affectedGroups: ["Farm and waste workers", "People with asthma", "Nearby residents"],
    whatToDo: {
      fair: ["Look for nearby waste or fertilizer sources."],
      usg: ["Leave the area and ventilate it", "Rinse eyes and skin with clean water"],
      "very-unhealthy": ["Stop or contain the source"],
      severe: ["Evacuate and move upwind", "Report the leak to emergency services"]
    },
    menroActions: ["Inspect nearby farms, dumpsites and wastewater facilities"]
  }
};

type Band = { lower: number; upper: number | null; iLow: number; iHigh: number };

// Guidance-based bands for the non-criteria indicators (same bands the dashboard uses).
const INDICATOR_BANDS: Partial<Record<PollutantKey, { max: number; bands: Band[] }>> = {
  co2: {
    max: 10000,
    bands: [
      { lower: 0, upper: 600, iLow: 0, iHigh: 50 },
      { lower: 600, upper: 1000, iLow: 51, iHigh: 100 },
      { lower: 1000, upper: 1500, iLow: 101, iHigh: 150 },
      { lower: 1500, upper: 2000, iLow: 151, iHigh: 200 },
      { lower: 2000, upper: 5000, iLow: 201, iHigh: 300 },
      { lower: 5000, upper: null, iLow: 301, iHigh: 500 }
    ]
  },
  nh3: {
    max: 300,
    bands: [
      { lower: 0, upper: 5, iLow: 0, iHigh: 50 },
      { lower: 5, upper: 25, iLow: 51, iHigh: 100 },
      { lower: 25, upper: 50, iLow: 101, iHigh: 150 },
      { lower: 50, upper: 100, iLow: 151, iHigh: 200 },
      { lower: 100, upper: 200, iLow: 201, iHigh: 300 },
      { lower: 200, upper: null, iLow: 301, iHigh: 500 }
    ]
  }
};

function bandIndex(value: number, max: number, bands: Band[]): number {
  for (const band of bands) {
    if (band.upper != null && value >= band.upper) continue;
    const upper = band.upper ?? max;
    const t = upper > band.lower ? (Math.min(value, upper) - band.lower) / (upper - band.lower) : 1;
    return Math.round(band.iLow + Math.max(0, Math.min(1, t)) * (band.iHigh - band.iLow));
  }
  return 500;
}

/** NO2 has no DENR AQI: its index is the percentage of the 24-hour guideline (80 ppb). */
export const NO2_GUIDELINE_PPB = 80;

/**
 * Index on the 0–500 AQI scale for any tracked pollutant, so all of them can share the
 * same colours and be ranked together. See IndexBasis for what each one means.
 */
export function pollutantIndex(key: PollutantKey, value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;

  const def = POLLUTANTS[key];
  if (def.aqiPollutant) return subIndex(def.aqiPollutant, value);
  if (key === "no2") return Math.min(500, Math.round((value / NO2_GUIDELINE_PPB) * 100));
  if (key === "voc") return Math.max(0, Math.min(500, Math.round(value)));

  const indicator = INDICATOR_BANDS[key];
  return indicator ? bandIndex(value, indicator.max, indicator.bands) : null;
}

export function indexCategory(index: number | null): CategoryInfo | null {
  return index == null ? null : categoryFor(index);
}

/** Index at or above which a pollutant counts as elevated (Unhealthy for Sensitive Groups). */
export const ELEVATED_INDEX = 101;
/** Index from which a pollutant is reported as approaching the elevated band. */
export const APPROACHING_INDEX = 76;

/** Concentration at which a pollutant enters the USG band, in its own unit. */
export function elevatedThreshold(key: PollutantKey): number | null {
  switch (key) {
    case "pm25":
      return 35.1;
    case "pm10":
      return 155;
    case "so2":
      return 145;
    case "co":
      return 9.5;
    case "no2":
      return NO2_GUIDELINE_PPB;
    case "co2":
      return 1000;
    case "nh3":
      return 25;
    case "voc":
      return 101;
  }
}
