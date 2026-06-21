package com.academicagent.platform.identity.service;

import java.time.Instant;
import java.util.UUID;

import com.academicagent.platform.common.ApiException;
import com.academicagent.platform.identity.crypto.JwtService;
import com.academicagent.platform.identity.crypto.PasswordHasher;
import com.academicagent.platform.identity.entity.User;
import com.academicagent.platform.identity.model.AuthResult;
import com.academicagent.platform.identity.model.UserProfile;
import com.academicagent.platform.identity.repository.UserRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {

    private final UserRepository userRepository;
    private final PasswordHasher passwordHasher;
    private final JwtService jwtService;
    private final UserService userService;

    public AuthService(
            UserRepository userRepository,
            PasswordHasher passwordHasher,
            JwtService jwtService,
            UserService userService) {
        this.userRepository = userRepository;
        this.passwordHasher = passwordHasher;
        this.jwtService = jwtService;
        this.userService = userService;
    }

    @Transactional
    public AuthResult register(String email, String password, String displayName) {
        if (userRepository.existsByEmailIgnoreCase(email)) {
            throw new ApiException("Email already registered", HttpStatus.CONFLICT, "email_exists");
        }
        User user = new User();
        user.setUserId(UUID.randomUUID().toString());
        user.setEmail(email.toLowerCase());
        user.setDisplayName(displayName);
        user.setPasswordHash(passwordHasher.hash(password));
        user.setCreatedAt(Instant.now());
        userRepository.save(user);
        return buildAuthResult(user);
    }

    @Transactional(readOnly = true)
    public AuthResult login(String email, String password) {
        User user = userRepository
                .findByEmailIgnoreCase(email)
                .orElseThrow(() -> new ApiException("Invalid credentials", HttpStatus.UNAUTHORIZED, "invalid_credentials"));
        if (!passwordHasher.matches(password, user.getPasswordHash())) {
            throw new ApiException("Invalid credentials", HttpStatus.UNAUTHORIZED, "invalid_credentials");
        }
        return buildAuthResult(user);
    }

    @Transactional(readOnly = true)
    public UserProfile getProfile(String userId) {
        return userService.getProfile(userId);
    }

    private AuthResult buildAuthResult(User user) {
        UserProfile profile = userService.toProfile(user);
        String token = jwtService.createToken(user.getUserId(), user.getEmail());
        return new AuthResult(token, "Bearer", jwtService.getExpirationSeconds(), profile);
    }
}
