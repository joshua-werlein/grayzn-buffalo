import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOfferContent} from './reconcile.js';

test('ONLY $price strips promotional label',()=>{
  assert.equal(normalizeOfferContent('ONLY $10.25'),'$10.25');
});
test('ONLY! $price strips promotional label',()=>{
  assert.equal(normalizeOfferContent('ONLY! $10.25'),'$10.25');
});
test('SPECIAL $price strips promotional label',()=>{
  assert.equal(normalizeOfferContent('SPECIAL $10.25'),'$10.25');
});
test('SPECIAL! $price strips promotional label',()=>{
  assert.equal(normalizeOfferContent('SPECIAL! $10.25'),'$10.25');
});
test('meaningful sentence only is unchanged',()=>{
  const s='The only burger available today is $12.99';
  assert.equal(normalizeOfferContent(s),s);
});
test('ONLY $.89 strips promotional label before sub-dollar price',()=>{
  assert.equal(normalizeOfferContent('ONLY $.89'),'$.89');
});
test('ONLY! $.89 strips promotional label before sub-dollar price',()=>{
  assert.equal(normalizeOfferContent('ONLY! $.89'),'$.89');
});
test('SPECIAL $.89 strips promotional label before sub-dollar price',()=>{
  assert.equal(normalizeOfferContent('SPECIAL $.89'),'$.89');
});
test('Wing Night $.89 Boneless Wings is unchanged',()=>{
  const s='Wing Night $.89 Boneless Wings';
  assert.equal(normalizeOfferContent(s),s);
});
test('Sunday Crispy Hawaiian offer strips ONLY before price',()=>{
  assert.equal(
    normalizeOfferContent('Crispy Hawaiian - Crispy chicken with ham, swiss cheese and pineapple Plus Side Salad, Chili or Coleslaw ONLY $10.25'),
    'Crispy Hawaiian - Crispy chicken with ham, swiss cheese and pineapple Plus Side Salad, Chili or Coleslaw $10.25'
  );
});
test('Sunday Chicken Sandwich offer strips ONLY before price',()=>{
  assert.equal(
    normalizeOfferContent('Chicken Sandwich - Fried or grilled chicken with fries or mashed potato gravy ONLY $9.25'),
    'Chicken Sandwich - Fried or grilled chicken with fries or mashed potato gravy $9.25'
  );
});
test('Sunday Wing Night offer unchanged (no ONLY before price)',()=>{
  const s='Wing Night - Bone-In Wings $0.79 each; Boneless Wings $0.75 each';
  assert.equal(normalizeOfferContent(s),s);
});
test('lowercase only before price is also stripped',()=>{
  assert.equal(normalizeOfferContent('Burger with fries only $8.50'),'Burger with fries $8.50');
});
test('content with no price label is unchanged',()=>{
  const s='Grilled Salmon with vegetables and rice pilaf';
  assert.equal(normalizeOfferContent(s),s);
});
