'use strict';

const nlp = require('compromise');

const NlpEntity = {
    ACRONYMS: 'acronyms',
    MONEY: 'money',
    ORGS: 'organizations',
    PEOPLE: 'people',
    PLACES: 'places'
};

const FixedPIIEntity = {
    CREDIT_CARD: 'CREDIT_CARD',
    CRYPTO: 'CRYPTO',
    DATE_TIME: 'DATE_TIME',
    EMAIL_ADDRESS: 'EMAIL_ADDRESS',
    IBAN_CODE: 'IBAN_CODE',
    IP_ADDRESS: 'IP_ADDRESS',
    PO_NUMBER: 'PO_NUMBER',
    PHONE_NUMBER: 'PHONE_NUMBER',
    URL: 'URL',
    CVV: 'CVV',
    BIC_SWIFT: 'BIC_SWIFT',
    US_BANK_NUMBER: 'US_BANK_NUMBER',
    US_DRIVER_LICENSE: 'US_DRIVER_LICENSE',
    US_ITIN: 'US_ITIN',
    US_PASSPORT: 'US_PASSPORT',
    US_SSN: 'US_SSN',
    UK_NHS: 'UK_NHS',
    UK_NINO: 'UK_NINO',
    ES_NIF: 'ES_NIF',
    ES_NIE: 'ES_NIE',
    IT_FISCAL_CODE: 'IT_FISCAL_CODE',
    IT_DOCUMENT: 'IT_DOCUMENT',
    IT_VAT_CODE: 'IT_VAT_CODE',
    PL_PESEL: 'PL_PESEL',
    FI_PERSONAL_IDENTITY_CODE: 'FI_PERSONAL_IDENTITY_CODE',
    SG_NRIC_FIN: 'SG_NRIC_FIN',
    SG_UEN: 'SG_UEN',
    AU_ABN: 'AU_ABN',
    AU_ACN: 'AU_ACN',
    AU_TFN: 'AU_TFN',
    AU_MEDICARE: 'AU_MEDICARE',
    IN_PAN: 'IN_PAN',
    IN_AADHAAR: 'IN_AADHAAR',
    IN_VEHICLE_REGISTRATION: 'IN_VEHICLE_REGISTRATION',
    IN_VOTER: 'IN_VOTER',
    IN_PASSPORT: 'IN_PASSPORT',
    KR_RRN: 'KR_RRN'
};

const SWIFT_KEYWORDS = [
    '(?:[sS][wW][iI][fF][tT])',
    '(?:[bB][iI][cC])',
    '(?:[bB][aA][nN][kK][\\s-]?[cC][oO][dD][eE])',
    '(?:[sS][wW][iI][fF][tT][\\s-]?[cC][oO][dD][eE])',
    '(?:[bB][iI][cC][\\s-]?[cC][oO][dD][eE])'
].join('|');

const SWIFT_REGEX = new RegExp(
    `(?:${SWIFT_KEYWORDS})[:\\s=]+([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\\b`,
    'g'
);

const FIXED_PATTERNS = {
    [FixedPIIEntity.CREDIT_CARD]: [/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g],
    [FixedPIIEntity.CRYPTO]: [/\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g],
    [FixedPIIEntity.DATE_TIME]: [
        /\b(0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])[/-](19|20)\d{2}\b/g
    ],
    [FixedPIIEntity.EMAIL_ADDRESS]: [
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
        /(?<=[?&=/])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
    ],
    [FixedPIIEntity.IBAN_CODE]: [
        /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}([A-Z0-9]?){0,16}\b/g
    ],
    [FixedPIIEntity.IP_ADDRESS]: [
        /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
        /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
        /\b(?:[0-9a-fA-F]{1,4}:){1,7}:|:(?::[0-9a-fA-F]{1,4}){1,7}\b/g
    ],
    [FixedPIIEntity.PO_NUMBER]: [/\b\d{8,10}(?:\/\d{1,5})?\b/g],
    [FixedPIIEntity.PHONE_NUMBER]: [
        /\+1\s*\(?\d{3}\)?\s*\d{3}[-.\s]\d{4}/g,
        /\b(\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g
    ],
    [FixedPIIEntity.URL]: [
        /\bhttps?:\/\/(?:[-\w.])+(?::[0-9]+)?(?:\/(?:[\w/_.])*(?:\?(?:[\w&=%.])*)?(?:#(?:[\w.])*)?)?/g
    ],
    [FixedPIIEntity.CVV]: [
        /\b(?:cvv|cvc|security\s*code|card\s*code)[\s:=]*[0-9]{3,4}\b/gi
    ],
    [FixedPIIEntity.BIC_SWIFT]: [SWIFT_REGEX],
    [FixedPIIEntity.US_BANK_NUMBER]: [/\b\d{8,17}\b/g],
    [FixedPIIEntity.US_DRIVER_LICENSE]: [/\b[A-Z]\d{7}\b/g],
    [FixedPIIEntity.US_ITIN]: [/\b9\d{2}-\d{2}-\d{4}\b/g],
    [FixedPIIEntity.US_PASSPORT]: [/\b[A-Z]\d{8}\b/g],
    [FixedPIIEntity.US_SSN]: [/\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/g],
    [FixedPIIEntity.UK_NHS]: [/\b\d{3} \d{3} \d{4}\b/g],
    [FixedPIIEntity.UK_NINO]: [/\b[A-Z]{2}\d{6}[A-Z]\b/g],
    [FixedPIIEntity.ES_NIF]: [/\b\d{8}[A-Z]\b/g],
    [FixedPIIEntity.ES_NIE]: [/\b[XYZ]\d{7}[A-Z]\b/g],
    [FixedPIIEntity.IT_FISCAL_CODE]: [
        /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/g
    ],
    [FixedPIIEntity.IT_DOCUMENT]: [/\b[A-Z]{2}\d{7}\b/g],
    [FixedPIIEntity.IT_VAT_CODE]: [/\bIT\d{11}\b/g],
    [FixedPIIEntity.PL_PESEL]: [/\b\d{11}\b/g],
    [FixedPIIEntity.FI_PERSONAL_IDENTITY_CODE]: [/\b\d{6}[+-A]\d{3}[A-Z0-9]\b/g],
    [FixedPIIEntity.SG_NRIC_FIN]: [/\b[A-Z]\d{7}[A-Z]\b/g],
    [FixedPIIEntity.SG_UEN]: [/\b\d{8}[A-Z]\b|\b\d{9}[A-Z]\b/g],
    [FixedPIIEntity.AU_ABN]: [/\b\d{2} \d{3} \d{3} \d{3}\b/g],
    [FixedPIIEntity.AU_ACN]: [/\b\d{3} \d{3} \d{3}\b/g],
    [FixedPIIEntity.AU_TFN]: [/\b\d{9}\b/g],
    [FixedPIIEntity.AU_MEDICARE]: [/\b\d{4} \d{5} \d{1}\b/g],
    [FixedPIIEntity.IN_PAN]: [/\b[A-Z]{5}\d{4}[A-Z]\b/g],
    [FixedPIIEntity.IN_AADHAAR]: [/\b\d{4} \d{4} \d{4}\b/g],
    [FixedPIIEntity.IN_VEHICLE_REGISTRATION]: [/\b[A-Z]{2}\d{2}[A-Z]{2}\d{4}\b/g],
    [FixedPIIEntity.IN_VOTER]: [/\b[A-Z]{3}\d{7}\b/g],
    [FixedPIIEntity.IN_PASSPORT]: [/\b[A-Z]\d{7}\b/g],
    [FixedPIIEntity.KR_RRN]: [
        /\b\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])-[1-4]\d{6}\b/g
    ]
};

const MASKED_TAG = /^<[A-Z_]+>$/;

function normalizeUnicode(text) {
    if (!text) {
        return text;
    }
    const zeroWidth = /(?:\u200B|\u200C|\u200D|\u2060|\uFEFF)/g;
    try {
        return text.normalize('NFKC').replace(zeroWidth, '');
    } catch {
        return text.replace(zeroWidth, '');
    }
}

function applyNlpRules(text, entities = Object.values(NlpEntity)) {
    if (!text || entities.length === 0) {
        return text;
    }

    return text
        .split(/(<[A-Z_]+>)/g)
        .map((segment) => {
            if (MASKED_TAG.test(segment)) {
                return segment;
            }

            const doc = nlp(segment);
            let result = segment;

            for (const entity of entities) {
                for (const val of doc[entity]().out('array')) {
                    if (val.length < 2) {
                        continue;
                    }
                    result = result.replaceAll(val, `<${entity.toUpperCase()}>`);
                }
            }

            return result;
        })
        .join('');
}

function applyCustomRules(text, rules) {
    if (!text || rules.length === 0) {
        return text;
    }
    let result = text;
    for (const rule of rules) {
        result = result.replace(rule.pattern, `<${rule.replacement}>`);
    }
    return result;
}

function applyFixedRules(text, entities = Object.values(FixedPIIEntity)) {
    if (!text) {
        return text;
    }
    let result = text;
    for (const entity of entities) {
        for (const regex of FIXED_PATTERNS[entity]) {
            result = result.replace(regex, `<${entity}>`);
        }
    }
    return result;
}

function mask(inputText, options = {}) {
    const {
        nlpRules = [],
        customRules = [],
        fixedPiiEntities = []
    } = options;

    let result = normalizeUnicode(inputText);

    const fixed = fixedPiiEntities.length === 0
        ? Object.values(FixedPIIEntity)
        : fixedPiiEntities;
    result = applyFixedRules(result, fixed);

    if (customRules.length > 0) {
        result = applyCustomRules(result, customRules);
    }

    if (nlpRules.length > 0) {
        result = applyNlpRules(result, nlpRules);
    }

    return result;
}

module.exports = {
    NlpEntity,
    FixedPIIEntity,
    mask
};
