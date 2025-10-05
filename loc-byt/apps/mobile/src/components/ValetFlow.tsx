import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, Alert, Modal } from 'react-native';
import { useTheme } from '../theme';
import { track } from '../analytics';
import { api } from '../api';

interface ValetBookingData {
  // Step 1: Service Overview
  valetId?: string;
  
  // Step 2: Booking Details
  personalInfo: {
    name: string;
    phone: string;
    email: string;
  };
  vehicleInfo: {
    make: string;
    model: string;
    color: string;
    year: string;
    licensePlate: string;
  };
  specialInstructions: string;
  pickupLocation: {
    address: string;
    latitude?: number;
    longitude?: number;
  };
  
  // Step 3: Payment
  paymentMethod: string;
  billingAddress: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };
  
  // Step 4-6: Service tracking
  bookingId?: string;
  valetAssignment?: {
    name: string;
    photo: string;
    rating: number;
    phone: string;
  };
  status?: 'requested' | 'assigned' | 'en_route' | 'arrived' | 'parked' | 'returning' | 'completed';
  verificationCode?: string;
}

interface ValetFlowProps {
  onComplete: (bookingData: ValetBookingData) => void;
  onCancel: () => void;
}

export default function ValetFlow({ onComplete, onCancel }: ValetFlowProps) {
  const theme = useTheme();
  const [currentStep, setCurrentStep] = useState(1);
  const [bookingData, setBookingData] = useState<ValetBookingData>({
    personalInfo: { name: '', phone: '', email: '' },
    vehicleInfo: { make: '', model: '', color: '', year: '', licensePlate: '' },
    specialInstructions: '',
    pickupLocation: { address: '' },
    paymentMethod: '',
    billingAddress: { street: '', city: '', state: '', zip: '' }
  });
  const [isLoading, setIsLoading] = useState(false);

  const updateBookingData = (updates: Partial<ValetBookingData>) => {
    setBookingData(prev => ({ ...prev, ...updates }));
  };

  const validateStep = (step: number): boolean => {
    switch (step) {
      case 2:
        const { personalInfo, vehicleInfo, pickupLocation } = bookingData;
        return !!(
          personalInfo.name && personalInfo.phone && personalInfo.email &&
          vehicleInfo.make && vehicleInfo.model && vehicleInfo.color && 
          vehicleInfo.year && vehicleInfo.licensePlate &&
          pickupLocation.address
        );
      case 3:
        return !!(bookingData.paymentMethod && 
          bookingData.billingAddress.street && bookingData.billingAddress.city);
      default:
        return true;
    }
  };

  const handleNextStep = async () => {
    if (!validateStep(currentStep)) {
      Alert.alert('Missing Information', 'Please fill in all required fields.');
      return;
    }

    if (currentStep === 3) {
      // Process payment and create booking
      await processBooking();
    } else {
      setCurrentStep(prev => prev + 1);
    }
    
    track('valet_step_completed', { step: currentStep });
  };

  const processBooking = async () => {
    setIsLoading(true);
    try {
      const response = await api('/api/valet/request', {
        method: 'POST',
        body: JSON.stringify(bookingData)
      });
      
      updateBookingData({
        bookingId: response.bookingId,
        status: 'requested'
      });
      
      setCurrentStep(4); // Move to tracking step
      track('valet_booking_created', { bookingId: response.bookingId });
    } catch (error) {
      Alert.alert('Booking Failed', 'Unable to process your valet request. Please try again.');
      console.error('Valet booking error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const renderStep1ServiceOverview = () => (
    <ScrollView style={{ flex: 1, padding: 20 }}>
      <Text style={{
        color: theme.color?.text || '#fff',
        fontSize: 28,
        fontWeight: '700',
        textAlign: 'center',
        marginBottom: 8
      }}>
        Premium Valet Service
      </Text>
      
      <Text style={{
        color: theme.color?.muted || '#bbb',
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 32
      }}>
        Professional valet parking with full insurance coverage
      </Text>

      {/* Valet Profile */}
      <View style={{
        backgroundColor: theme.color?.border || '#333',
        borderRadius: 12,
        padding: 16,
        marginBottom: 24
      }}>
        <Text style={{
          color: theme.color?.text || '#fff',
          fontSize: 18,
          fontWeight: '700',
          marginBottom: 8
        }}>
          Michael Chen
        </Text>
        <Text style={{
          color: theme.color?.accent || '#22c55e',
          fontSize: 14,
          marginBottom: 4
        }}>
          ⭐ 4.9 • 500+ services completed
        </Text>
        <Text style={{
          color: theme.color?.muted || '#bbb',
          fontSize: 12
        }}>
          Certified • Insured • Background Checked
        </Text>
      </View>

      {/* Pricing */}
      <View style={{
        backgroundColor: theme.color?.border || '#333',
        borderRadius: 12,
        padding: 16,
        marginBottom: 24
      }}>
        <Text style={{
          color: theme.color?.text || '#fff',
          fontSize: 16,
          fontWeight: '600',
          marginBottom: 8
        }}>
          Service Pricing
        </Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
          <Text style={{ color: theme.color?.muted || '#bbb' }}>Base Rate</Text>
          <Text style={{ color: theme.color?.text || '#fff' }}>$25.00/hour</Text>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
          <Text style={{ color: theme.color?.muted || '#bbb' }}>Service Fee</Text>
          <Text style={{ color: theme.color?.text || '#fff' }}>$5.00</Text>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
          <Text style={{ color: theme.color?.muted || '#bbb' }}>Insurance</Text>
          <Text style={{ color: theme.color?.accent || '#22c55e' }}>Included</Text>
        </View>
        <View style={{
          borderTopWidth: 1,
          borderTopColor: theme.color?.muted || '#bbb',
          paddingTop: 8,
          flexDirection: 'row',
          justifyContent: 'space-between'
        }}>
          <Text style={{ color: theme.color?.text || '#fff', fontWeight: '600' }}>
            Estimated Total (1 hour)
          </Text>
          <Text style={{ color: theme.color?.accent || '#22c55e', fontWeight: '700' }}>
            $30.00
          </Text>
        </View>
      </View>

      {/* Service Area */}
      <View style={{
        backgroundColor: theme.color?.border || '#333',
        borderRadius: 12,
        padding: 16,
        marginBottom: 24
      }}>
        <Text style={{
          color: theme.color?.text || '#fff',
          fontSize: 16,
          fontWeight: '600',
          marginBottom: 8
        }}>
          Service Area
        </Text>
        <Text style={{
          color: theme.color?.muted || '#bbb',
          fontSize: 14
        }}>
          Downtown, SOMA, Mission Bay, and Financial District
        </Text>
      </View>
    </ScrollView>
  );

  const renderStep2BookingDetails = () => (
    <ScrollView style={{ flex: 1, padding: 20 }}>
      <Text style={{
        color: theme.color?.text || '#fff',
        fontSize: 24,
        fontWeight: '700',
        marginBottom: 24
      }}>
        Booking Details
      </Text>

      {/* Personal Information */}
      <Text style={{
        color: theme.color?.text || '#fff',
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 12
      }}>
        Personal Information
      </Text>
      
      <TextInput
        style={{
          backgroundColor: theme.color?.border || '#333',
          color: theme.color?.text || '#fff',
          padding: 12,
          borderRadius: 8,
          marginBottom: 12,
          fontSize: 16
        }}
        placeholder="Full Name"
        placeholderTextColor={theme.color?.muted || '#bbb'}
        value={bookingData.personalInfo.name}
        onChangeText={(text) => updateBookingData({
          personalInfo: { ...bookingData.personalInfo, name: text }
        })}
      />

      <TextInput
        style={{
          backgroundColor: theme.color?.border || '#333',
          color: theme.color?.text || '#fff',
          padding: 12,
          borderRadius: 8,
          marginBottom: 12,
          fontSize: 16
        }}
        placeholder="Phone Number"
        placeholderTextColor={theme.color?.muted || '#bbb'}
        keyboardType="phone-pad"
        value={bookingData.personalInfo.phone}
        onChangeText={(text) => updateBookingData({
          personalInfo: { ...bookingData.personalInfo, phone: text }
        })}
      />

      <TextInput
        style={{
          backgroundColor: theme.color?.border || '#333',
          color: theme.color?.text || '#fff',
          padding: 12,
          borderRadius: 8,
          marginBottom: 24,
          fontSize: 16
        }}
        placeholder="Email Address"
        placeholderTextColor={theme.color?.muted || '#bbb'}
        keyboardType="email-address"
        autoCapitalize="none"
        value={bookingData.personalInfo.email}
        onChangeText={(text) => updateBookingData({
          personalInfo: { ...bookingData.personalInfo, email: text }
        })}
      />

      {/* Vehicle Information */}
      <Text style={{
        color: theme.color?.text || '#fff',
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 12
      }}>
        Vehicle Information
      </Text>

      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
        <TextInput
          style={{
            backgroundColor: theme.color?.border || '#333',
            color: theme.color?.text || '#fff',
            padding: 12,
            borderRadius: 8,
            fontSize: 16,
            flex: 1
          }}
          placeholder="Make"
          placeholderTextColor={theme.color?.muted || '#bbb'}
          value={bookingData.vehicleInfo.make}
          onChangeText={(text) => updateBookingData({
            vehicleInfo: { ...bookingData.vehicleInfo, make: text }
          })}
        />
        <TextInput
          style={{
            backgroundColor: theme.color?.border || '#333',
            color: theme.color?.text || '#fff',
            padding: 12,
            borderRadius: 8,
            fontSize: 16,
            flex: 1
          }}
          placeholder="Model"
          placeholderTextColor={theme.color?.muted || '#bbb'}
          value={bookingData.vehicleInfo.model}
          onChangeText={(text) => updateBookingData({
            vehicleInfo: { ...bookingData.vehicleInfo, model: text }
          })}
        />
      </View>

      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
        <TextInput
          style={{
            backgroundColor: theme.color?.border || '#333',
            color: theme.color?.text || '#fff',
            padding: 12,
            borderRadius: 8,
            fontSize: 16,
            flex: 1
          }}
          placeholder="Color"
          placeholderTextColor={theme.color?.muted || '#bbb'}
          value={bookingData.vehicleInfo.color}
          onChangeText={(text) => updateBookingData({
            vehicleInfo: { ...bookingData.vehicleInfo, color: text }
          })}
        />
        <TextInput
          style={{
            backgroundColor: theme.color?.border || '#333',
            color: theme.color?.text || '#fff',
            padding: 12,
            borderRadius: 8,
            fontSize: 16,
            flex: 1
          }}
          placeholder="Year"
          placeholderTextColor={theme.color?.muted || '#bbb'}
          keyboardType="numeric"
          value={bookingData.vehicleInfo.year}
          onChangeText={(text) => updateBookingData({
            vehicleInfo: { ...bookingData.vehicleInfo, year: text }
          })}
        />
      </View>

      <TextInput
        style={{
          backgroundColor: theme.color?.border || '#333',
          color: theme.color?.text || '#fff',
          padding: 12,
          borderRadius: 8,
          marginBottom: 24,
          fontSize: 16
        }}
        placeholder="License Plate"
        placeholderTextColor={theme.color?.muted || '#bbb'}
        autoCapitalize="characters"
        value={bookingData.vehicleInfo.licensePlate}
        onChangeText={(text) => updateBookingData({
          vehicleInfo: { ...bookingData.vehicleInfo, licensePlate: text }
        })}
      />

      {/* Pickup Location */}
      <Text style={{
        color: theme.color?.text || '#fff',
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 12
      }}>
        Pickup Location
      </Text>

      <TextInput
        style={{
          backgroundColor: theme.color?.border || '#333',
          color: theme.color?.text || '#fff',
          padding: 12,
          borderRadius: 8,
          marginBottom: 24,
          fontSize: 16
        }}
        placeholder="Street Address"
        placeholderTextColor={theme.color?.muted || '#bbb'}
        value={bookingData.pickupLocation.address}
        onChangeText={(text) => updateBookingData({
          pickupLocation: { ...bookingData.pickupLocation, address: text }
        })}
      />

      {/* Special Instructions */}
      <Text style={{
        color: theme.color?.text || '#fff',
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 12
      }}>
        Special Instructions (Optional)
      </Text>

      <TextInput
        style={{
          backgroundColor: theme.color?.border || '#333',
          color: theme.color?.text || '#fff',
          padding: 12,
          borderRadius: 8,
          marginBottom: 24,
          fontSize: 16,
          height: 80,
          textAlignVertical: 'top'
        }}
        placeholder="Any special instructions for the valet..."
        placeholderTextColor={theme.color?.muted || '#bbb'}
        multiline
        maxLength={500}
        value={bookingData.specialInstructions}
        onChangeText={(text) => updateBookingData({ specialInstructions: text })}
      />
    </ScrollView>
  );

  const renderStep3Payment = () => (
    <ScrollView style={{ flex: 1, padding: 20 }}>
      <Text style={{
        color: theme.color?.text || '#fff',
        fontSize: 24,
        fontWeight: '700',
        marginBottom: 24
      }}>
        Payment Information
      </Text>

      {/* Payment Method Selection */}
      <Text style={{
        color: theme.color?.text || '#fff',
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 12
      }}>
        Payment Method
      </Text>

      <TouchableOpacity
        style={{
          backgroundColor: bookingData.paymentMethod === 'card'
            ? (theme.color?.accent || '#22c55e')
            : (theme.color?.border || '#333'),
          padding: 16,
          borderRadius: 8,
          marginBottom: 12,
          flexDirection: 'row',
          alignItems: 'center'
        }}
        onPress={() => updateBookingData({ paymentMethod: 'card' })}
      >
        <Text style={{ fontSize: 20, marginRight: 12 }}>💳</Text>
        <Text style={{
          color: bookingData.paymentMethod === 'card' ? '#000' : (theme.color?.text || '#fff'),
          fontSize: 16,
          fontWeight: '600'
        }}>
          Credit/Debit Card
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={{
          backgroundColor: bookingData.paymentMethod === 'apple_pay'
            ? (theme.color?.accent || '#22c55e')
            : (theme.color?.border || '#333'),
          padding: 16,
          borderRadius: 8,
          marginBottom: 24,
          flexDirection: 'row',
          alignItems: 'center'
        }}
        onPress={() => updateBookingData({ paymentMethod: 'apple_pay' })}
      >
        <Text style={{ fontSize: 20, marginRight: 12 }}>📱</Text>
        <Text style={{
          color: bookingData.paymentMethod === 'apple_pay' ? '#000' : (theme.color?.text || '#fff'),
          fontSize: 16,
          fontWeight: '600'
        }}>
          Apple Pay
        </Text>
      </TouchableOpacity>

      {/* Billing Address */}
      <Text style={{
        color: theme.color?.text || '#fff',
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 12
      }}>
        Billing Address
      </Text>

      <TextInput
        style={{
          backgroundColor: theme.color?.border || '#333',
          color: theme.color?.text || '#fff',
          padding: 12,
          borderRadius: 8,
          marginBottom: 12,
          fontSize: 16
        }}
        placeholder="Street Address"
        placeholderTextColor={theme.color?.muted || '#bbb'}
        value={bookingData.billingAddress.street}
        onChangeText={(text) => updateBookingData({
          billingAddress: { ...bookingData.billingAddress, street: text }
        })}
      />

      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
        <TextInput
          style={{
            backgroundColor: theme.color?.border || '#333',
            color: theme.color?.text || '#fff',
            padding: 12,
            borderRadius: 8,
            fontSize: 16,
            flex: 2
          }}
          placeholder="City"
          placeholderTextColor={theme.color?.muted || '#bbb'}
          value={bookingData.billingAddress.city}
          onChangeText={(text) => updateBookingData({
            billingAddress: { ...bookingData.billingAddress, city: text }
          })}
        />
        <TextInput
          style={{
            backgroundColor: theme.color?.border || '#333',
            color: theme.color?.text || '#fff',
            padding: 12,
            borderRadius: 8,
            fontSize: 16,
            flex: 1
          }}
          placeholder="State"
          placeholderTextColor={theme.color?.muted || '#bbb'}
          value={bookingData.billingAddress.state}
          onChangeText={(text) => updateBookingData({
            billingAddress: { ...bookingData.billingAddress, state: text }
          })}
        />
        <TextInput
          style={{
            backgroundColor: theme.color?.border || '#333',
            color: theme.color?.text || '#fff',
            padding: 12,
            borderRadius: 8,
            fontSize: 16,
            flex: 1
          }}
          placeholder="ZIP"
          placeholderTextColor={theme.color?.muted || '#bbb'}
          keyboardType="numeric"
          value={bookingData.billingAddress.zip}
          onChangeText={(text) => updateBookingData({
            billingAddress: { ...bookingData.billingAddress, zip: text }
          })}
        />
      </View>

      {/* Order Summary */}
      <View style={{
        backgroundColor: theme.color?.border || '#333',
        borderRadius: 12,
        padding: 16,
        marginTop: 24
      }}>
        <Text style={{
          color: theme.color?.text || '#fff',
          fontSize: 18,
          fontWeight: '700',
          marginBottom: 12
        }}>
          Order Summary
        </Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
          <Text style={{ color: theme.color?.muted || '#bbb' }}>Valet Service (1 hour)</Text>
          <Text style={{ color: theme.color?.text || '#fff' }}>$25.00</Text>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
          <Text style={{ color: theme.color?.muted || '#bbb' }}>Service Fee</Text>
          <Text style={{ color: theme.color?.text || '#fff' }}>$5.00</Text>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
          <Text style={{ color: theme.color?.muted || '#bbb' }}>Tax</Text>
          <Text style={{ color: theme.color?.text || '#fff' }}>$2.70</Text>
        </View>
        <View style={{
          borderTopWidth: 1,
          borderTopColor: theme.color?.muted || '#bbb',
          paddingTop: 8,
          flexDirection: 'row',
          justifyContent: 'space-between'
        }}>
          <Text style={{ color: theme.color?.text || '#fff', fontWeight: '700', fontSize: 16 }}>
            Total
          </Text>
          <Text style={{ color: theme.color?.accent || '#22c55e', fontWeight: '700', fontSize: 16 }}>
            $32.70
          </Text>
        </View>
      </View>
    </ScrollView>
  );

  const renderStep4Tracking = () => (
    <ScrollView style={{ flex: 1, padding: 20 }}>
      <Text style={{
        color: theme.color?.text || '#fff',
        fontSize: 24,
        fontWeight: '700',
        textAlign: 'center',
        marginBottom: 8
      }}>
        Service Requested
      </Text>

      <Text style={{
        color: theme.color?.muted || '#bbb',
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 32
      }}>
        We're finding the perfect valet for you
      </Text>

      {/* Status Indicator */}
      <View style={{
        backgroundColor: theme.color?.border || '#333',
        borderRadius: 12,
        padding: 20,
        alignItems: 'center',
        marginBottom: 24
      }}>
        <Text style={{ fontSize: 48, marginBottom: 12 }}>🔍</Text>
        <Text style={{
          color: theme.color?.accent || '#22c55e',
          fontSize: 18,
          fontWeight: '700',
          marginBottom: 4
        }}>
          Finding Valet
        </Text>
        <Text style={{
          color: theme.color?.muted || '#bbb',
          fontSize: 14,
          textAlign: 'center'
        }}>
          This usually takes 2-5 minutes
        </Text>
      </View>

      {/* Booking Details */}
      <View style={{
        backgroundColor: theme.color?.border || '#333',
        borderRadius: 12,
        padding: 16,
        marginBottom: 24
      }}>
        <Text style={{
          color: theme.color?.text || '#fff',
          fontSize: 16,
          fontWeight: '600',
          marginBottom: 12
        }}>
          Booking Details
        </Text>
        <Text style={{ color: theme.color?.muted || '#bbb', marginBottom: 4 }}>
          Vehicle: {bookingData.vehicleInfo.color} {bookingData.vehicleInfo.year} {bookingData.vehicleInfo.make} {bookingData.vehicleInfo.model}
        </Text>
        <Text style={{ color: theme.color?.muted || '#bbb', marginBottom: 4 }}>
          License: {bookingData.vehicleInfo.licensePlate}
        </Text>
        <Text style={{ color: theme.color?.muted || '#bbb' }}>
          Pickup: {bookingData.pickupLocation.address}
        </Text>
      </View>
    </ScrollView>
  );

  const renderCurrentStep = () => {
    switch (currentStep) {
      case 1: return renderStep1ServiceOverview();
      case 2: return renderStep2BookingDetails();
      case 3: return renderStep3Payment();
      case 4: return renderStep4Tracking();
      default: return renderStep1ServiceOverview();
    }
  };

  const getStepTitle = () => {
    switch (currentStep) {
      case 1: return 'Service Overview';
      case 2: return 'Booking Details';
      case 3: return 'Payment';
      case 4: return 'Service Tracking';
      default: return 'Valet Service';
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen">
      <View style={{
        flex: 1,
        backgroundColor: theme.color?.bg || '#0b0b0b'
      }}>
        {/* Header */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 20,
          paddingTop: 50,
          borderBottomWidth: 1,
          borderBottomColor: theme.color?.border || '#333'
        }}>
          <TouchableOpacity onPress={onCancel}>
            <Text style={{
              color: theme.color?.muted || '#bbb',
              fontSize: 16
            }}>
              Cancel
            </Text>
          </TouchableOpacity>

          <Text style={{
            color: theme.color?.text || '#fff',
            fontSize: 18,
            fontWeight: '600'
          }}>
            {getStepTitle()}
          </Text>

          <Text style={{
            color: theme.color?.muted || '#bbb',
            fontSize: 14
          }}>
            {currentStep}/4
          </Text>
        </View>

        {/* Progress Bar */}
        <View style={{
          height: 4,
          backgroundColor: theme.color?.border || '#333',
          marginHorizontal: 20,
          marginTop: 10,
          borderRadius: 2
        }}>
          <View style={{
            height: '100%',
            backgroundColor: theme.color?.accent || '#22c55e',
            width: `${(currentStep / 4) * 100}%`,
            borderRadius: 2
          }} />
        </View>

        {/* Content */}
        <View style={{ flex: 1 }}>
          {renderCurrentStep()}
        </View>

        {/* Footer */}
        {currentStep < 4 && (
          <View style={{
            padding: 20,
            borderTopWidth: 1,
            borderTopColor: theme.color?.border || '#333',
            flexDirection: 'row',
            gap: 12
          }}>
            {currentStep > 1 && (
              <TouchableOpacity
                style={{
                  backgroundColor: 'transparent',
                  borderWidth: 1,
                  borderColor: theme.color?.border || '#333',
                  paddingVertical: 16,
                  borderRadius: 12,
                  alignItems: 'center',
                  flex: 1
                }}
                onPress={() => setCurrentStep(prev => prev - 1)}
              >
                <Text style={{
                  color: theme.color?.muted || '#bbb',
                  fontSize: 16,
                  fontWeight: '600'
                }}>
                  Back
                </Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={{
                backgroundColor: validateStep(currentStep)
                  ? (theme.color?.accent || '#22c55e')
                  : (theme.color?.border || '#333'),
                paddingVertical: 16,
                borderRadius: 12,
                alignItems: 'center',
                flex: 2
              }}
              onPress={handleNextStep}
              disabled={!validateStep(currentStep) || isLoading}
            >
              <Text style={{
                color: validateStep(currentStep) ? '#000' : (theme.color?.muted || '#bbb'),
                fontSize: 16,
                fontWeight: '700'
              }}>
                {isLoading ? 'Processing...' :
                 currentStep === 3 ? 'Book Valet Service' : 'Continue'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}
