const fs = require('fs');
const path = 'c:/Users/GERARDO CANALES/Documents/UC/IndicAlerts/index.js';
let content = fs.readFileSync(path, 'utf8');

// Correcciones específicas para remover espacios accidentales en template literals e HTML
content = content.replace(/translateY\(-50 %\)/g, 'translateY(-50%)');
content = content.replace(/rotate\(\s*\$\{\s*marketSummary\.rocketAngle\s*\}deg\s*\)/g, 'rotate(${marketSummary.rocketAngle}deg)');
content = content.replace(/grayscale\(\s*\$\{\s*1 - marketSummary\.saturation\s*\}\s*\)/g, 'grayscale(${1 - marketSummary.saturation})');
content = content.replace(/opacity\(\s*\$\{\s*marketSummary\.opacity\s*\}\s*\)/g, 'opacity(${marketSummary.opacity})');
content = content.replace(/\$\{\s*symbol\s*\}\s*_2h/g, '${symbol}_2h');
content = content.replace(/\$\s*\$\{\s*estado\.currentPrice\s*\}\s*/g, '$${estado.currentPrice}');
content = content.replace(/< span/g, '<span');
content = content.replace(/<\/span >/g, '</span>');
content = content.replace(/< div/g, '<div');
content = content.replace(/<\/div >/g, '</div>');
content = content.replace(/< tr/g, '<tr');
content = content.replace(/<\/tr >/g, '</tr>');
content = content.replace(/\$\{\s*h\.observation\s*\}/g, '${h.observation}');
content = content.replace(/\$\{\s*marketSummary\.dominantState\.toUpperCase\(\)\s*\}/g, '${marketSummary.dominantState.toUpperCase()}');
content = content.replace(/\$\{\s*marketSummary\.rocketColor\s*\}/g, '${marketSummary.rocketColor}');
content = content.replace(/\s*%\)/g, '%)'); // General para el % de translateY

fs.writeFileSync(path, content);
console.log('index.js limpiado con éxito.');
